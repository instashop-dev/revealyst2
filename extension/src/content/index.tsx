import { createRoot } from "react-dom/client";
import { createElement } from "react";
import type { ScoreResult } from "@revealyst/scoring";
import type { Suggestion } from "../shared/types.js";
import type { ScoreEventPayload } from "../shared/types.js";
import { CLIENT_TIPS } from "../shared/types.js";
import styles from "./styles.css?inline";
import { detectPlatform, waitForInput, type PlatformDef } from "../lib/platform.js";
import { applySuggestion, getInputText, isEditable } from "../lib/apply.js";
import { createDebouncedScorer, scorePrompt } from "../lib/scoring.js";
import {
  appendLocalHistory,
  clearLocalHistory,
  completeOnboarding,
  getLocalHistory,
  getSettings,
  isOnboarded,
  rateLocalHistory,
  setSettings,
} from "../lib/storage.js";
import { Sidebar } from "./sidebar.js";
import type { TeamOption } from "./settings-panel.js";

/**
 * Content script: injects the Revealyst sidebar (shadow DOM, 300px, right
 * side) into supported LLM pages, scores prompts locally on a 2s debounce,
 * requests suggestions via the service worker, applies them with one click,
 * records thumbs ratings (visible after the LLM responds — spec §5.1) and
 * saves prompts to the team library using the settings token/team.
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
  let localHistory = await getLocalHistory();
  let result: ScoreResult | null = null;
  let suggestions: Suggestion[] = [];
  let suggestionSource: "vectorize+llm" | "static" | null = null;
  let busy = false;
  let lastApplied: string | null = null;
  let showOnboarding = !(await isOnboarded());
  let inputMissing = false;
  let input: HTMLElement | null = null;
  let lastHash = "";
  let lastPromptText = "";
  let thumbsVisible = false;

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
        thumbsVisible,
        localHistory: [...localHistory],
        onPauseToggle: () => void togglePause(),
        onApply: (s) => applySuggestionToInput(s),
        onThumbs: (rating) => void recordRating(rating),
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
        onSaveSettings: (patch) => {
          void setSettings(patch).then((s) => {
            Object.assign(settings, s);
            rerender();
          });
        },
        onClearHistory: () => {
          void clearLocalHistory().then(() => {
            localHistory = [];
            rerender();
          });
        },
        loadTeams: (token) => loadTeamsFromApi(token),
      }),
    );
  }
  const reactRoot = createRoot(root);

  // ---- LLM response detection (spec §5.1: thumbs appear after the response) --
  function checkResponseDetected(): boolean {
    for (const selector of def.responseSelectors) {
      if (document.querySelector(selector)) return true;
    }
    return false;
  }
  thumbsVisible = checkResponseDetected();
  const responseObserver = new MutationObserver(() => {
    if (!thumbsVisible && checkResponseDetected()) {
      thumbsVisible = true;
      rerender();
    }
  });
  responseObserver.observe(document.body, { childList: true, subtree: true });

  // ---- scoring + suggestions ---------------------------------------------
  function onScored(update: { result: ScoreResult; hash: string; prompt: string }): void {
    const flagsChanged =
      !result || JSON.stringify(result.flags) !== JSON.stringify(update.result.flags);
    result = update.result;
    lastHash = update.hash;
    lastPromptText = update.prompt;
    localHistory = [
      {
        prompt: lastPromptText.slice(0, 2000),
        score: update.result.score,
        flags: update.result.flags,
        platform: def.id,
        rating: null,
        createdAt: new Date().toISOString(),
      },
      ...localHistory,
    ].slice(0, 100);
    void appendLocalHistory(localHistory[0]!);
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
          promptHash: update.hash,
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
          // Spec §7: server unreachable → static generic tips from a
          // client-side fallback list.
          busy = false;
          suggestions = CLIENT_TIPS;
          suggestionSource = "static";
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
    // Record acceptance feedback (spec §5.6 suggestions_feedback) when the
    // user has connected their account; silent otherwise (no account yet).
    if (settings.apiToken) {
      void chrome.runtime
        .sendMessage({
          type: "POST_FEEDBACK",
          suggestionId: suggestion.id,
          wasAccepted: true,
          token: settings.apiToken,
          apiBase: settings.apiBase,
        })
        .catch(() => undefined);
    }
    // Re-score immediately after the suggestion is applied.
    const text = getInputText(input);
    void scorePrompt(text).then(onScored);
    rerender();
  }

  async function recordRating(rating: 1 | -1): Promise<void> {
    if (!lastHash) return;
    // Local history (device-only) gets the rating so the snippet view shows it.
    void rateLocalHistory(lastPromptText.slice(0, 2000), def.id, rating).then(() => {
      localHistory = localHistory.map((h) =>
        h.prompt === lastPromptText.slice(0, 2000) && h.platform === def.id && h.rating === null
          ? { ...h, rating }
          : h,
      );
      rerender();
    });
    // Cloud event: only scores/flags/hash/rating leave the device (privacy §5.7).
    if (settings.cloudSync) {
      const payload: ScoreEventPayload = {
        prompt_hash: lastHash,
        score: result?.score ?? 0,
        flags: result?.flags ?? [],
        breakdown: result?.breakdown ?? {},
        llm_platform: def.id,
        rating,
      };
      void chrome.runtime
        .sendMessage({ type: "LOG_EVENT", apiBase: settings.apiBase, payload })
        .catch(() => undefined);
    }
  }

  async function saveCurrentToLibrary(): Promise<void> {
    if (!isEditable(input)) return;
    const text = getInputText(input);
    if (!text.trim()) return;
    if (!settings.apiToken) {
      lastApplied = "Add your API token in Settings (⚙️)";
      rerender();
      return;
    }
    if (!settings.teamId) {
      lastApplied = "Pick a team in Settings (⚙️)";
      rerender();
      return;
    }
    try {
      await chrome.runtime.sendMessage({
        type: "SAVE_LIBRARY",
        apiBase: settings.apiBase,
        token: settings.apiToken,
        payload: {
          team_id: settings.teamId,
          prompt_text: text,
          title: text.slice(0, 60),
          tags: [def.id],
          score: result?.score ?? 0,
        },
      });
      lastApplied = "Saved to library ⭐";
      rerender();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed";
      lastApplied =
        message.includes("Unauthorized") || message.includes("401")
          ? "Session expired — refresh your token in Settings"
          : `Save failed — ${message}`;
      rerender();
    }
  }

  async function loadTeamsFromApi(token: string): Promise<TeamOption[]> {
    const res = (await chrome.runtime.sendMessage({
      type: "GET_TEAMS",
      token,
      apiBase: settings.apiBase,
    })) as { error?: string } | TeamOption[];
    if (Array.isArray(res)) return res;
    throw new Error(res.error ?? "teams failed");
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
