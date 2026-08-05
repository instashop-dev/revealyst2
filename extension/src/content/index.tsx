import { createRoot } from "react-dom/client";
import { createElement } from "react";
import type { ScoreResult } from "@revealyst/scoring";
import type { Suggestion } from "../shared/types.js";
import type { ScoreEventPayload } from "../shared/types.js";
import styles from "./styles.css?inline";
import { detectPlatform, waitForInput, type PlatformDef } from "../lib/platform.js";
import { applySuggestion, getInputText, isEditable } from "../lib/apply.js";
import { createDebouncedScorer, scorePrompt } from "../lib/scoring.js";
import { completeOnboarding, getSettings, isOnboarded, setSettings } from "../lib/storage.js";
import { Sidebar } from "./sidebar.js";

/**
 * Content script: injects the Revealyst sidebar (shadow DOM, 300px, right
 * side) into supported LLM pages, scores prompts locally on a 2s debounce,
 * requests suggestions via the service worker, and applies them with one click.
 */
console.log("[revealyst] content script starting");

async function main(): Promise<void> {
  try {
    await mainUnsafe();
  } catch (error) {
    console.error("[revealyst] content script failed:", error);
  }
}

async function mainUnsafe(): Promise<void> {
  const settings = await getSettings();
  const platform = detectPlatform(window.location.href, settings.platformSelectors);
  if (!platform) return; // unsupported page — do nothing
  const def: PlatformDef = platform;

  // ---- shadow-DOM sidebar host (mounted immediately so the UI is never
  // delayed by input polling; inputMissing flips when the poll ends) ------
  const host = document.createElement("div");
  host.id = "revealyst-sidebar-host";
  host.style.cssText = "position:fixed;top:0;right:0;height:100vh;width:300px;z-index:2147483000;";
  const shadow = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = styles; // Tailwind, scoped inside the shadow DOM
  shadow.appendChild(styleEl);
  const root = document.createElement("div");
  root.className = "revealyst-root";
  shadow.appendChild(root);
  document.documentElement.appendChild(host);

  // ---- state -------------------------------------------------------------
  const scorer = createDebouncedScorer();
  const history: ScoreResult[] = [];
  let result: ScoreResult | null = null;
  let suggestions: Suggestion[] = [];
  let suggestionSource: "vectorize+llm" | "static" | null = null;
  let busy = false;
  let lastApplied: string | null = null;
  let showOnboarding = !(await isOnboarded());
  let inputMissing = false;
  let input: HTMLElement | null = null;

  function rerender(): void {
    reactRoot.render(
      createElement(Sidebar, {
        settings,
        result,
        suggestions,
        suggestionSource,
        busy,
        showOnboarding,
        inputMissing,
        truncated: result?.meta.truncated ?? false,
        lastApplied,
        history: [...history],
        onPauseToggle: () => void togglePause(),
        onApply: (s) => applySuggestionToInput(s),
        onThumbs: (accepted) => {
          void chrome.runtime.sendMessage({
            type: "LOG_EVENT",
            apiBase: settings.apiBase,
            payload: {
              prompt_hash: `feedback:${Date.now()}`,
              score: result?.score ?? 0,
              flags: accepted ? [] : ["feedback_down"],
              breakdown: result?.breakdown ?? {},
              llm_platform: def.id,
            },
          });
        },
        onSaveToLibrary: () => void saveCurrentToLibrary(),
        onOnboardingDone: () => {
          showOnboarding = false;
          void completeOnboarding();
          rerender();
        },
        onCloudSyncToggle: (enabled) => {
          void setSettings({ cloudSync: enabled }).then((s) => {
            settings.cloudSync = s.cloudSync;
            rerender();
          });
        },
      }),
    );
  }
  const reactRoot = createRoot(root);

  // ---- scoring + suggestions ---------------------------------------------
  function onScored(update: { result: ScoreResult; hash: string }): void {
    const flagsChanged =
      !result || JSON.stringify(result.flags) !== JSON.stringify(update.result.flags);
    result = update.result;
    history.unshift(update.result);
    if (history.length > 12) history.pop();
    if (settings.cloudSync) {
      const payload: ScoreEventPayload = {
        prompt_hash: update.hash,
        score: update.result.score,
        flags: update.result.flags,
        breakdown: update.result.breakdown,
        llm_platform: def.id,
      };
      void chrome.runtime.sendMessage({ type: "LOG_EVENT", apiBase: settings.apiBase, payload });
    }
    if (flagsChanged) {
      // Only refetch suggestions when the deficiencies changed; otherwise keep
      // the current suggestions (also avoids re-render removing them mid-click).
      busy = true;
      suggestions = [];
      suggestionSource = null;
      void chrome.runtime
        .sendMessage({
          type: "GET_SUGGESTIONS",
          flags: update.result.flags,
          breakdown: update.result.breakdown,
          apiBase: settings.apiBase,
        })
        .then((res) => {
          busy = false;
          const parsed = res as {
            suggestions?: Suggestion[];
            source?: "vectorize+llm" | "static";
            error?: string;
          };
          if (parsed.error) {
            suggestions = [];
            suggestionSource = null;
          } else {
            suggestions = parsed.suggestions ?? [];
            suggestionSource = parsed.source ?? null;
          }
          rerender();
        })
        .catch(() => {
          busy = false;
          rerender();
        });
    }
    rerender();
  }

  function onInput(): void {
    if (settings.paused || !isEditable(input)) return;
    const text = getInputText(input);
    if (!text.trim()) return;
    scorer.schedule(text, onScored);
  }

  function onBlur(): void {
    if (settings.paused || !isEditable(input)) return;
    const text = getInputText(input);
    if (!text.trim()) return;
    scorer.flush(text, onScored);
  }

  function applySuggestionToInput(suggestion: Suggestion): void {
    if (!isEditable(input)) return;
    lastApplied = suggestion.preview;
    applySuggestion(input, suggestion);
    // Re-score immediately after the suggestion is applied.
    const text = getInputText(input);
    void scorePrompt(text).then(onScored);
    rerender();
  }

  async function saveCurrentToLibrary(): Promise<void> {
    if (!isEditable(input)) return;
    const text = getInputText(input);
    if (!text.trim()) return;
    try {
      await chrome.runtime.sendMessage({
        type: "SAVE_LIBRARY",
        apiBase: settings.apiBase,
        payload: {
          team_id: "", // requires an opted-in team id; surfaced in Settings
          prompt_text: text,
          title: text.slice(0, 60),
          tags: [def.id],
          score: result?.score ?? 0,
        },
      });
      lastApplied = "Saved to library ⭐";
      rerender();
    } catch {
      lastApplied = "Save failed — team sync off?";
      rerender();
    }
  }

  async function togglePause(): Promise<void> {
    const next = await setSettings({ paused: !settings.paused });
    settings.paused = next.paused;
    if (settings.paused) scorer.cancel();
    rerender();
  }

  // ---- wire input events (input arrives async; poll then attach) ---------
  rerender();
  input = await waitForInput(document, platform);
  inputMissing = input === null;
  rerender();
  if (input) {
    input.addEventListener("input", onInput);
    input.addEventListener("blur", onBlur);
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      input.addEventListener("keydown", (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter") onBlur();
      });
    }
  }
  console.log(`[revealyst] sidebar active on ${def.name} (input ${input ? "found" : "MISSING"})`);
}

void main();
