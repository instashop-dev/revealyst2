import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setStatus("idle");
    try {
      await api.requestMagicLink(email);
      setStatus("sent");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Something went wrong");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold text-emerald-700">Revealyst</h1>
        <p className="mt-1 text-sm text-zinc-500">Turn every prompt into a step forward.</p>

        {status === "sent" ? (
          <div className="mt-6 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">
            Link sent! Check your inbox for the magic sign-in link.
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
            <label className="text-sm font-medium text-zinc-700" htmlFor="email">
              Work email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              placeholder="you@company.com"
            />
            {status === "error" && <p className="text-sm text-red-600">{message}</p>}
            <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
              Send me a magic link
            </button>
            <p className="text-xs text-zinc-400">
              Don&apos;t have a team? You can still track your personal progress after signing in.
            </p>
            <Link to="/" className="text-center text-xs text-emerald-600 hover:underline">
              ← Back
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
