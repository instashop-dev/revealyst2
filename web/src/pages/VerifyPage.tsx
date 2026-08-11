import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/session.js";

/** Handles ?token= from the emailed magic link: verify → session → redirect. */
export function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setError("Missing token — use the link from your email.");
      return;
    }
    login(token)
      .then(() => navigate("/progress", { replace: true }))
      .catch(() => setError("This link is invalid or expired."));
  }, [params, login, navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="rounded-lg bg-red-50 p-4 text-center text-sm text-red-700">
          <p>{error}</p>
          <Link
            to="/login"
            className="mt-2 inline-block text-xs font-semibold text-red-600 underline hover:text-red-800"
          >
            Request a new sign-in link
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
      Signing you in…
    </div>
  );
}
