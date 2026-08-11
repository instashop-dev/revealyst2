import { bandFor } from "@revealyst/scoring";
import { useEffect, useRef, useState } from "react";
import type { ScoreResult } from "@revealyst/scoring";
import type { LocalHistoryEntry, Settings, Suggestion } from "../shared/types.js";
import { SettingsPanel, type TeamOption } from "./settings-panel.js";

export interface SidebarProps {
  settings: Settings;
  result: ScoreResult | null;
  suggestions: Suggestion[];
  suggestionSource: "vectorize+llm" | "static" | null;
  busy: boolean;
  showOnboarding: boolean;
  inputMissing: boolean;
  truncated: boolean;
  lastApplied: string | null;
  /** Thumbs row visibility — spec §5.1: shown after the LLM response appears. */
  thumbsVisible: boolean;
  onPauseToggle: () => void;
  onCollapseToggle: () => void;
  onApply: (suggestion: Suggestion) => void;
  onThumbs: (rating: 1 | -1) => void;
  onSaveToLibrary: () => void;
  onOnboardingDone: () => void;
  onCloudSyncToggle: (enabled: boolean) => void;
  onSaveSettings: (patch: Partial<Settings>) => void;
  onClearHistory: () => void;
  localHistory: LocalHistoryEntry[];
  loadTeams: (token: string) => Promise<TeamOption[]>;
}

const DIMENSION_LABELS: Record<string, string> = {
  specificity: "Specificity",
  context: "Context",
  role_clarity: "Role clarity",
  output_format: "Output format",
  examples_included: "Examples",
};

const BAND_COLORS: Record<string, string> = {
  red: "bg-red-500",
  yellow: "bg-amber-400",
  green: "bg-green-500",
};

export function Sidebar(props: SidebarProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [props.result?.score]);

  if (props.inputMissing) {
    return (
      <div className="p-4 text-sm text-zinc-700">
        <p className="font-semibold text-red-600">Revealyst can't find the input field</p>
        <p className="mt-1 text-zinc-500">
          We're updating our selectors — scoring will resume shortly.
        </p>
      </div>
    );
  }

  if (props.showOnboarding) {
    return (
      <div className="flex h-full flex-col gap-4 p-4">
        <p className="text-lg font-bold">Welcome to Revealyst 👋</p>
        <div className="rounded-lg border border-zinc-200 p-3">
          <p className="text-sm font-semibold">Step 1 — See your score</p>
          <p className="text-xs text-zinc-500">Type a prompt and watch the live quality meter.</p>
          <div className="mt-2 rounded bg-zinc-100 p-2 text-center font-mono text-sm">
            72 · green
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 p-3">
          <p className="text-sm font-semibold">Step 2 — Improve with one click</p>
          <p className="text-xs text-zinc-500">
            When your score is low, tap Apply to upgrade the prompt instantly.
          </p>
          <div className="mt-2 rounded bg-zinc-100 p-2 text-xs text-zinc-600">
            Act as a senior copywriter. ✨ Apply
          </div>
        </div>
        <button
          className="mt-auto rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
          onClick={props.onOnboardingDone}
        >
          Got it — start coaching
        </button>
      </div>
    );
  }

  if (settingsOpen) {
    return (
      <SettingsPanel
        settings={props.settings}
        localHistory={props.localHistory}
        onSave={(patch) => {
          props.onSaveSettings(patch);
          setSettingsOpen(false);
        }}
        onClearHistory={props.onClearHistory}
        loadTeams={props.loadTeams}
      />
    );
  }

  // Collapsed: a slim tab so the panel never permanently covers the chat.
  // Restore with one click (spec §5.1 user controls).
  if (props.settings.sidebarCollapsed) {
    return (
      <div className="flex h-full items-center justify-center">
        <button
          onClick={props.onCollapseToggle}
          className="flex flex-col items-center gap-2 rounded-lg px-1 py-2 text-emerald-700 hover:bg-emerald-50"
          title="Expand Revealyst panel"
        >
          <span className="text-lg leading-none">✨</span>
          <span className="text-[10px] font-semibold [writing-mode:vertical-rl]">
            Revealyst
          </span>
        </button>
      </div>
    );
  }

  const score = props.result?.score ?? 0;
  const band = props.result ? bandFor(score) : "yellow";

  return (
    <div className="flex h-full flex-col gap-3 p-4 text-sm">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-emerald-700">Revealyst</span>
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
            BETA
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
              props.settings.paused ? "bg-zinc-200 text-zinc-600" : "bg-emerald-600 text-white"
            }`}
            onClick={props.onPauseToggle}
            title={props.settings.paused ? "Resume scoring" : "Pause scoring"}
          >
            {props.settings.paused ? "Paused" : "Pause"}
          </button>
          <button
            className="rounded px-1.5 py-1 text-sm hover:bg-zinc-100"
            onClick={props.onCollapseToggle}
            title="Collapse the panel to a slim tab"
          >
            ▸
          </button>
          <button
            className="rounded px-1.5 py-1 text-sm hover:bg-zinc-100"
            onClick={() => setSettingsOpen(true)}
            title="Settings — token, team, local history"
          >
            ⚙️
          </button>
        </div>
      </header>

      <section className="rounded-xl border border-zinc-200 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-500">Prompt Quality Score</span>
          <span className="text-[10px] text-zinc-400">
            {props.truncated ? "truncated · first 1000 chars" : ""}
          </span>
        </div>
        {props.result?.meta.engine === "rules" && props.result.meta.modelError && (
          <p className="mt-1 text-[10px] text-amber-600" title={props.result.meta.modelError}>
            local model unavailable · using rule engine (spec §7)
          </p>
        )}
        <div className="mt-1 flex items-baseline gap-2">
          <span
            className={`font-mono text-4xl font-bold ${BAND_COLORS[band] ?? "bg-zinc-400"} bg-clip-text text-transparent`}
          >
            {props.result ? score : "—"}
          </span>
          <span className="text-xs capitalize text-zinc-400">
            {props.result ? band : "waiting for input"}
          </span>
        </div>
        {props.result && (
          <div className="mt-3 grid grid-cols-5 gap-1">
            {Object.entries(props.result.breakdown).map(([dim, value]) => (
              <div key={dim} title={`${DIMENSION_LABELS[dim] ?? dim}: ${value}/100`}>
                <div className="h-1.5 rounded bg-zinc-100">
                  <div
                    className={`h-1.5 rounded ${BAND_COLORS[bandFor(value)]}`}
                    style={{ width: `${value}%` }}
                  />
                </div>
                <p className="mt-0.5 truncate text-[9px] text-zinc-400">
                  {DIMENSION_LABELS[dim] ?? dim}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex-1 overflow-y-auto">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-500">Suggestions</span>
          {props.suggestionSource === "static" && (
            <span
              className="text-[10px] text-zinc-400"
              title="Server unreachable — using offline tips"
            >
              offline tips
            </span>
          )}
        </div>
        <div ref={listRef} className="flex flex-col gap-2">
          {props.busy && <p className="text-xs text-zinc-400">Analyzing…</p>}
          {!props.busy && props.suggestions.length === 0 && (
            <p className="text-xs text-zinc-400">
              {props.result && score >= 70
                ? "Looking great — keep it up! 🎉"
                : "Start typing to get coaching."}
            </p>
          )}
          {props.suggestions.map((s) => (
            <div key={s.id} className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-2">
              <p className="text-xs text-zinc-700">{s.text}</p>
              <button
                className="mt-1.5 rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700"
                onClick={() => props.onApply(s)}
              >
                Apply
              </button>
            </div>
          ))}
          {props.lastApplied && (
            <p className="text-[10px] text-emerald-700">
              Applied: “{props.lastApplied.slice(0, 60)}…”
            </p>
          )}
        </div>
      </section>

      <footer className="flex items-center justify-between border-t border-zinc-100 pt-2 text-[11px] text-zinc-400">
        {props.thumbsVisible ? (
          <div className="flex items-center gap-1">
            <button
              className="rounded px-1.5 py-1 hover:bg-zinc-100"
              onClick={() => props.onThumbs(1)}
              title="This prompt was helpful"
            >
              👍
            </button>
            <button
              className="rounded px-1.5 py-1 hover:bg-zinc-100"
              onClick={() => props.onThumbs(-1)}
              title="This prompt needs work"
            >
              👎
            </button>
          </div>
        ) : (
          <span className="text-[10px] text-zinc-300">Rate after the LLM responds</span>
        )}
        <button
          className="rounded px-1.5 py-1 hover:bg-zinc-100"
          onClick={props.onSaveToLibrary}
          title="Save to library"
        >
          ⭐
        </button>
        <button
          className={`rounded px-1.5 py-1 ${props.settings.cloudSync ? "text-emerald-600" : ""}`}
          onClick={() => props.onCloudSyncToggle(!props.settings.cloudSync)}
          title={props.settings.cloudSync ? "Cloud sync on" : "Cloud sync off (privacy-first)"}
        >
          {props.settings.cloudSync ? "Cloud sync: on" : "Cloud sync: off"}
        </button>
      </footer>
    </div>
  );
}
