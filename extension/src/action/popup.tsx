import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import { getSettings, setSettings } from "../lib/storage.js";
import { DASHBOARD_URL } from "../shared/types.js";

/**
 * Extension action popup — the entry point users see when clicking the
 * toolbar icon (the sidebar itself only exists on supported LLM pages).
 *
 * Connect methods (spec §5.1):
 *  1. Paste the API token from the dashboard (Settings → Connect the
 *     extension) — validated against /api/auth/me.
 *  2. Email magic link (no token yet) — same flow as the sidebar panel.
 * Also links to the supported sites + web dashboard.
 */

const SETTINGS_URL = `${DASHBOARD_URL}/settings`;
const LLM_SITES = [
  { name: "ChatGPT", url: "https://chat.openai.com/" },
  { name: "Claude", url: "https://claude.ai/" },
  { name: "Gemini", url: "https://gemini.google.com/" },
];

function sendMessage(message: Record<string, unknown>): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

export function Popup() {
  const [apiToken, setApiToken] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  // Primary path: pasted dashboard API token.
  const [tokenInput, setTokenInput] = useState("");
  // Secondary path: email magic link.
  const [showEmailFlow, setShowEmailFlow] = useState(false);
  const [connectEmail, setConnectEmail] = useState("");
  const [magicSent, setMagicSent] = useState(false);
  const [magicCode, setMagicCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getSettings().then((s) => {
      setApiToken(s.apiToken);
      setAccountEmail(s.accountEmail);
    });
  }, []);

  /** Primary: paste the API token from the dashboard and validate it. */
  async function connectWithToken() {
    const token = tokenInput.trim();
    if (!token) {
      setStatus("Paste your API token from the dashboard first.");
      return;
    }
    setBusy(true);
    setStatus("Verifying…");
    try {
      const settings = await getSettings();
      const res = (await sendMessage({
        type: "GET_ME",
        token,
        apiBase: settings.apiBase,
      })) as { error?: string; status?: number } | { email?: string };
      if (res && "error" in res && res.error) {
        const err = new Error(res.error) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const email = (res as { email?: string }).email ?? "";
      await setSettings({ apiToken: token, accountEmail: email });
      setApiToken(token);
      setAccountEmail(email);
      setStatus("Connected ✓ — open ChatGPT, Claude or Gemini to start coaching.");
    } catch (error) {
      const statusCode = (error as { status?: number }).status;
      setStatus(
        statusCode === 401
          ? "That token is invalid or expired — copy a fresh one from the dashboard (Settings → Connect the extension)."
          : "Could not connect — check your network and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Secondary: email a single-use magic link. */
  async function sendLink() {
    const email = connectEmail.trim();
    if (!email || !email.includes("@")) {
      setStatus("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setStatus("Sending…");
    try {
      const settings = await getSettings();
      const res = (await sendMessage({
        type: "REQUEST_MAGIC_LINK",
        email,
        apiBase: settings.apiBase,
      })) as { error?: string };
      if (res.error) throw new Error(res.error);
      setMagicSent(true);
      setStatus("Link sent — check your inbox, then paste it below (don't click it).");
    } catch {
      setStatus("Could not send — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Accept either the full emailed URL or the bare token (query or hash). */
  function extractToken(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.includes("token=")) return trimmed;
    const match = trimmed.match(/[?#&]token=([^&#]+)/);
    return match ? decodeURIComponent(match[1]!) : trimmed;
  }

  async function connectWithMagicLink() {
    const magic = extractToken(magicCode);
    if (!magic) {
      setStatus("Paste the full link from the email (or just its token).");
      return;
    }
    setBusy(true);
    setStatus("Connecting…");
    try {
      const settings = await getSettings();
      const res = (await sendMessage({
        type: "VERIFY_MAGIC_TOKEN",
        token: magic,
        apiBase: settings.apiBase,
      })) as { error?: string; status?: number } | { token: string; email?: string };
      if (res && "error" in res && res.error) {
        const err = new Error(res.error) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const ok = res as { token: string; email?: string };
      await setSettings({ apiToken: ok.token, accountEmail: ok.email ?? "" });
      setApiToken(ok.token);
      setAccountEmail(ok.email ?? "");
      setStatus("Connected ✓ — open ChatGPT, Claude or Gemini to start coaching.");
    } catch (error) {
      const statusCode = (error as { status?: number }).status;
      setStatus(
        statusCode === 429
          ? "Too many attempts — wait a minute and try again."
          : "That link is invalid, expired or already used — request a new one.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await setSettings({ apiToken: "", accountEmail: "", teamId: "" });
    setApiToken("");
    setAccountEmail("");
    setStatus("Disconnected.");
  }

  const connected = Boolean(apiToken);

  return (
    <div className="w-80 bg-white p-4 text-sm text-zinc-800">
      <header className="flex items-center justify-between">
        <p className="text-base font-bold text-emerald-700">Revealyst</p>
        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
          BETA
        </span>
      </header>

      <section className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
        {connected ? (
          <div>
            <p className="text-sm font-semibold text-emerald-800">Connected to Revealyst</p>
            <p className="mt-1 truncate text-xs text-zinc-600">{accountEmail || "(token set)"}</p>
            <button
              onClick={() => void disconnect()}
              className="mt-2 rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm font-semibold text-emerald-800">Connect your account</p>
            <p className="mt-1 text-[11px] leading-snug text-zinc-500">
              Two ways to connect — paste your API token, or sign in by email.
            </p>

            <div className="mt-2 flex flex-col gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Paste your API token"
                className="rounded-lg border border-zinc-300 px-2 py-1.5 font-mono text-[11px]"
              />
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => void connectWithToken()}
                  className="flex-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy ? "…" : "Connect with token"}
                </button>
                <a
                  href={SETTINGS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded-lg border border-emerald-300 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                >
                  Get token ↗
                </a>
              </div>
              <p className="text-[10px] leading-snug text-zinc-400">
                From the dashboard: Settings → Connect the extension → Copy token.
              </p>
            </div>

            <button
              onClick={() => setShowEmailFlow((v) => !v)}
              className="mt-2 text-[11px] font-semibold text-emerald-700 hover:underline"
            >
              {showEmailFlow ? "Hide email sign-in" : "No token yet? Sign in with email"}
            </button>

            {showEmailFlow && (
              <div className="mt-2 flex flex-col gap-2 border-t border-emerald-200 pt-2">
                {!magicSent ? (
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={connectEmail}
                      onChange={(e) => setConnectEmail(e.target.value)}
                      placeholder="you@company.com"
                      className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-2 py-1.5 text-xs"
                    />
                    <button
                      disabled={busy}
                      onClick={() => void sendLink()}
                      className="shrink-0 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {busy ? "…" : "Send"}
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <input
                      value={magicCode}
                      onChange={(e) => setMagicCode(e.target.value)}
                      placeholder="Paste the link from the email"
                      className="rounded-lg border border-zinc-300 px-2 py-1.5 text-xs"
                    />
                    <div className="flex gap-2">
                      <button
                        disabled={busy}
                        onClick={() => void connectWithMagicLink()}
                        className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {busy ? "…" : "Connect"}
                      </button>
                      <button
                        onClick={() => {
                          setMagicSent(false);
                          setStatus(null);
                        }}
                        className="rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                      >
                        Back
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {status && <p className="mt-2 text-[11px] leading-snug text-zinc-500">{status}</p>}
      </section>

      <section className="mt-3">
        <p className="text-[11px] font-medium text-zinc-500">Works on</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {LLM_SITES.map((s) => (
            <a
              key={s.name}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-zinc-300 px-2.5 py-1 text-[11px] text-zinc-700 hover:bg-zinc-100"
            >
              {s.name}
            </a>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-snug text-zinc-400">
          The sidebar appears on those sites. On other pages Chrome shows “Can't read or change
          site's data” — that's expected, not a problem.
        </p>
      </section>

      <footer className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-2">
        <a
          href={DASHBOARD_URL}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] font-semibold text-emerald-700 hover:underline"
        >
          Open dashboard ↗
        </a>
        <span className="text-[10px] text-zinc-400">Prompt quality coach</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
