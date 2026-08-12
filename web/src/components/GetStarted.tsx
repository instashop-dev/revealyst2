import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * First-run checklist shown on the Progress page while a user has no synced
 * data (PMF review: the web app had no onboarding). Every step is actionable
 * in the app; the extension-install step is honest about the beta distribution
 * (the extension is not yet on the Chrome Web Store).
 */
export function GetStarted() {
  const steps: Array<{ title: string; body: ReactNode }> = [
    {
      title: "Install the extension",
      body: (
        <>
          Revealyst runs as a Chrome extension and shows a coaching sidebar on ChatGPT, Claude and
          Gemini. It is not on the Chrome Web Store yet, so download the latest build directly:{" "}
          <a
            href="/revealyst-extension.zip"
            download="revealyst-extension.zip"
            className="font-semibold text-emerald-700 hover:underline"
          >
            Download the extension (zip)
          </a>
          . Unzip the file, open <code>chrome://extensions</code>, turn on <b>Developer mode</b> and
          click <b>Load unpacked</b> to select the unzipped folder.
        </>
      ),
    },
    {
      title: "Connect your account",
      body: (
        <>
          Copy your API token from{" "}
          <Link to="/settings" className="font-semibold text-emerald-700 hover:underline">
            Settings → Connect the extension
          </Link>
          , click the Revealyst toolbar icon and paste it under <b>Connect with token</b>.
        </>
      ),
    },
    {
      title: "Turn on Cloud sync",
      body: (
        <>
          Open the sidebar Settings (⚙️) on any supported site and switch on <b>Cloud sync</b>. Only
          scores, flags and prompt hashes sync — prompt text never leaves your device.
        </>
      ),
    },
    {
      title: "Score your first prompt",
      body: (
        <>
          Type a prompt on ChatGPT, Claude or Gemini. Your score trend, history and achievements
          appear here and in the team analytics.
        </>
      ),
    },
  ];

  return (
    <div className="rounded-2xl border border-zinc-200 p-6">
      <h2 className="text-sm font-semibold text-zinc-700">Get started</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Four steps to your first coaching session — about 2 minutes.
      </p>
      <ol className="mt-4 space-y-4">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-medium text-zinc-700">{step.title}</p>
              <p className="mt-0.5 text-sm text-zinc-500">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-400">
        No data yet? Score a prompt with the extension and this page fills in automatically.
      </p>
    </div>
  );
}
