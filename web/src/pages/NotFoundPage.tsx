import { Link } from "react-router-dom";

/**
 * Fallback for unmatched URLs. Previously an unknown path rendered the app
 * shell with a blank content area — a dead end (PMF review).
 */
export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-5xl">🧭</p>
      <h1 className="text-xl font-bold">Page not found</h1>
      <p className="text-sm text-zinc-500">
        That address doesn&apos;t exist — or it moved. Your scores and history are safe.
      </p>
      <Link
        to="/progress"
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
      >
        Go to Progress
      </Link>
    </div>
  );
}
