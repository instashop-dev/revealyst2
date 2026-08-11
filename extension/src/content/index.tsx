import { createRoot } from "react-dom/client";
import { createElement } from "react";
import type { ScoreResult } from "@revealyst/scoring";
import type { Suggestion } from "../shared/types.js";
import type { ScoreEventPayload } from "../shared/types.js";
import { CLIENT_TIPS } from "../shared/types.js";
import styles from "./styles.css?inline";
import { detectPlatform, findInput, waitForInput, type PlatformDef } from "../lib/platform.js";
import {
  applySuggestion,
  getInputText,
  isEditable,
  setInputText,
  type AppliedFeedback,
} from "../lib/apply.js";
import { createDebouncedScorer, scorePrompt } from "../lib/scoring.js";
import {
  appendLocalHistory,
  clearLocalHistory,
  completeOnboarding,
  getLocalHistory,
  getSettings,
  isOnboarded,
  mergeLocalHistory,
  rateLocalHistory,
  setSettings,
} from "../lib/storage.js";
import { Sidebar } from "./sidebar.js";
import type { TeamOption } from "./settings-panel.js";

/** Sample prompt inserted by the onboarding "Try a sample prompt" demo
 *  (spec §5.8). Deliberately vague so the live score is low and real
 *  suggestions appear. */
const ONBOARDING_SAMPLE_PROMPT = "Help me write something good for my team.";

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
  // Stable per-install anonymous id (spec §5.5 pseudonyms): groups team trends
  // before sign-in; never links to an identity. Generated once, persisted.
  if (!settings.anonId) {
    const anonId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    Object.assign(settings, await setSettings({ anonId }));
  }
  const platform = detectPlatform(window.location.href);
  if (!platform) return; // unsupported page — do nothing
  const def: PlatformDef = platform;

  // ---- shadow-DOM sidebar host (mounted immediately so the UI is never
  // delayed by input polling; inputMissing flips when the poll ends) ------
  const host = document.createElement("div");
  host.id = "revealyst-sidebar-host";
  const applyHostWidth = () => {
    // Collapsible panel (spec §5.1 user controls): a slim tab when collapsed
    // so the overlay never permanently covers ~22% of the LLM chat.
    host.style.cssText = `position:fixed;top:0;right:0;height:100vh;width:${
      settings.sidebarCollapsed ? "40px" : "300px"
    };z-index:2147483000;`;
  };
  applyHostWidth();
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
  let appliedFeedback: AppliedFeedback | null = null;
  let statusMessage: string | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let showOnboarding = !(await isOnboarded());
  let onboardingSampleActive = false;
  let inputMissing = false;
  let input: HTMLElement | null = null;
  let lastHash = "";
  let lastPromptText = "";
  let thumbsVisible = false;
  // The prompt whose LLM response is currently on screen — thumbs rate THIS
  // prompt, not whatever was scored most recently.
  let responseHash = "";
  let responsePromptText = "";
  // Which thumb the user clicked (1 | -1 | 0 = not rated yet).
  let ratedValue: 0 | 1 | -1 = 0;

  function rerender(): void {
    reactRoot.render(
      createElement(Sidebar, {
        settings,
        result,
        suggestions,
        suggestionSource,
        busy,
        showOnboarding,
        onboardingSampleActive,
        inputMissing,
        truncated: result?.meta.truncated ?? false,
        appliedFeedback,
        statusMessage,
        thumbsVisible,
        ratedValue,
        localHistory: [...localHistory],
        onPauseToggle: () => void togglePause(),
        onCollapseToggle: () => {
          void setSettings({ sidebarCollapsed: !settings.sidebarCollapsed }).then((s) => {
            settings.sidebarCollapsed = s.sidebarCollapsed;
            applyHostWidth();
            rerender();
          });
        },
        onTrySample: () => {
          // Live demo (spec §5.8): insert a sample prompt, score it, and let
          // the user apply a real suggestion — onboarding teaches the flow.
          if (!input) return;
          setInputText(input, ONBOARDING_SAMPLE_PROMPT);
          onboardingSampleActive = true;
          onInput();
          rerender();
        },
        onApply: (s) => applySuggestionToInput(s),
        onUseTemplate: (prompt) => {
          // Empty-state starter prompts: fill the composer and score it live
          // (same flow as the onboarding sample, so the user sees the loop).
          if (!input) return;
          setInputText(input, prompt);
          onInput();
          rerender();
        },
        onThumbs: (rating) => void recordRating(rating),
        onSaveToLibrary: () => void saveCurrentToLibrary(),
        onOnboardingDone: () => {
          showOnboarding = false;
          void completeOnboarding();
          rerender();
        },
        onSaveSettings: (patch) => {
          void setSettings(patch).then((s) => {
            Object.assign(settings, s);
            applyHostWidth();
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
      // The response belongs to the prompt that is currently in the input —
      // capture it now so the thumbs rate the right prompt.
      responseHash = lastHash;
      responsePromptText = lastPromptText;
      ratedValue = 0;
      rerender();
    }
  });
  responseObserver.observe(document.body, { childList: true, subtree: true });

  // ---- event sync (attributed when the user has connected their account) ---
  // The live meter can re-score the same settled prompt (debounce flush,
  // suggestion apply), which would duplicate identical events and inflate the
  // server's re-prompt rate (§4 KPI). Skip a score event whose hash matches
  // the previous one; ratings always pass through (spec §5.4).
  let lastCloudHash: string | null = null;
  function sendEvent(payload: ScoreEventPayload): void {
    if (payload.rating == null) {
      if (payload.prompt_hash === lastCloudHash) return;
      lastCloudHash = payload.prompt_hash;
    }
    void (async () => {
      const attempt = (body: ScoreEventPayload, withTeam: boolean) =>
        chrome.runtime.sendMessage({
          type: "LOG_EVENT",
          apiBase: settings.apiBase,
          token: settings.apiToken || undefined,
          payload: {
            ...body,
            user_anon_id: settings.anonId,
            ...(withTeam && settings.teamId ? { team_id: settings.teamId } : {}),
          },
        });
      const res = (await attempt(payload, true)) as { status?: number } | undefined;
      // Team attribution is membership-checked; if the user left the team,
      // drop it and still record the event on the personal dashboard.
      if (res?.status === 403 && settings.teamId) {
        await attempt(payload, false);
      }
    })().catch(() => undefined);
  }

  // ---- scoring + suggestions ---------------------------------------------
  function onScored(update: { result: ScoreResult; hash: string; prompt: string }): void {
    const flagsChanged =
      !result || JSON.stringify(result.flags) !== JSON.stringify(update.result.flags);
    result = update.result;
    lastHash = update.hash;
    lastPromptText = update.prompt;
    // Merge, never blindly prepend: re-scores of the same prompt (blur flush,
    // suggestion apply) update the head row instead of duplicating it.
    localHistory = mergeLocalHistory(localHistory, {
      prompt: lastPromptText.slice(0, 2000),
      score: update.result.score,
      flags: update.result.flags,
      platform: def.id,
      rating: null,
      createdAt: new Date().toISOString(),
    });
    void appendLocalHistory(localHistory[0]!);
    if (settings.cloudSync) {
      sendEvent({
        prompt_hash: update.hash,
        score: update.result.score,
        flags: update.result.flags,
        breakdown: update.result.breakdown,
        llm_platform: def.id,
      });
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
            // Spec §7: the suggestion API is unreachable/erroring — degrade to
            // the client-side generic tips instead of showing nothing.
            suggestions = CLIENT_TIPS;
            suggestionSource = "static";
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
    // Composing a new prompt (different from the one whose response is on
    // screen) resets the thumbs: they rate the previous exchange, not this
    // new one.
    if (responseHash && text !== responsePromptText) {
      responseHash = "";
      responsePromptText = "";
      thumbsVisible = false;
      ratedValue = 0;
      rerender();
    }
    scorer.schedule(text, onScored);
  }

  function onBlur(): void {
    if (settings.paused || !isEditable(input)) return;
    const text = getInputText(input);
    if (!text.trim()) return;
    scorer.flush(text, onScored);
  }

  function applySuggestionToInput(suggestion: Suggestion): void {
    // Advisory suggestions have no insertable preview (the engine cannot
    // know the user's task) — nothing to apply.
    if (suggestion.advisory || !suggestion.preview) return;
    if (!isEditable(input)) return;
    const before = result?.score ?? null;
    appliedFeedback = { preview: suggestion.preview, before, after: null };
    // Clear the "Applied …" line after a few seconds instead of leaving it
    // forever.
    setTimeout(() => {
      appliedFeedback = null;
      rerender();
    }, 6000);
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
    // Re-score immediately after the suggestion is applied; the new score
    // fills the delta in the "Applied …" feedback (loop closure, §5.3).
    const text = getInputText(input);
    void scorePrompt(text).then((update) => {
      if (appliedFeedback) appliedFeedback.after = update.result.score;
      onScored(update);
    });
    rerender();
  }

  async function recordRating(rating: 1 | -1): Promise<void> {
    // Rate the prompt whose response is on screen; fall back to the last
    // scored prompt when no response was captured yet.
    const promptText = responsePromptText || lastPromptText;
    const hash = responseHash || lastHash;
    if (!hash || !promptText) return;
    ratedValue = rating;
    // Local history (device-only) gets the rating so the snippet view shows it.
    void rateLocalHistory(promptText.slice(0, 2000), def.id, rating).then(() => {
      localHistory = localHistory.map((h) =>
        h.prompt === promptText.slice(0, 2000) && h.platform === def.id && h.rating === null
          ? { ...h, rating }
          : h,
      );
      rerender();
    });
    // Cloud event: only scores/flags/hash/rating leave the device (privacy §5.7).
    if (settings.cloudSync) {
      sendEvent({
        prompt_hash: hash,
        score: result?.score ?? 0,
        flags: result?.flags ?? [],
        breakdown: result?.breakdown ?? {},
        llm_platform: def.id,
        rating,
      });
    }
    flashStatus(
      rating === 1 ? "Thanks — marked as helpful 👍" : "Thanks — marked as needs work 👎",
    );
  }

  /** Show a transient save/connect status line that auto-clears. */
  function flashStatus(message: string): void {
    statusMessage = message;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusMessage = null;
      rerender();
    }, 5000);
    rerender();
  }

  async function saveCurrentToLibrary(): Promise<void> {
    if (!isEditable(input)) return;
    const text = getInputText(input);
    if (!text.trim()) return;
    if (!settings.apiToken) {
      flashStatus("Connect your account in the Revealyst toolbar popup");
      return;
    }
    if (!settings.teamId) {
      flashStatus("Pick a team in Settings (⚙️)");
      return;
    }
    try {
      const res = (await chrome.runtime.sendMessage({
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
      })) as { error?: string; status?: number } | { id: string };
      // sendMessage resolves with {error} on failure (service worker catch).
      if (res && "error" in res && res.error) {
        const err = new Error(res.error) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      flashStatus("Saved to library ⭐");
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : "Save failed";
      flashStatus(
        status === 401 || message.includes("Unauthorized")
          ? "Session expired — refresh your token in Settings"
          : `Save failed — ${message}`,
      );
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
  const onEnter = (e: Event) => {
    if ((e as KeyboardEvent).key === "Enter") onBlur();
  };

  /** Attach listeners to the given input element, replacing the old one. */
  function attachInput(el: HTMLElement): void {
    if (input === el) return;
    if (input) {
      input.removeEventListener("input", onInput);
      input.removeEventListener("blur", onBlur);
      input.removeEventListener("keydown", onEnter);
    }
    input = el;
    inputMissing = false;
    input.addEventListener("input", onInput);
    input.addEventListener("blur", onBlur);
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      el.addEventListener("keydown", onEnter);
    }
    rerender();
  }

  rerender();
  const initialInput = await waitForInput(document, platform);
  inputMissing = initialInput === null;
  rerender();
  if (initialInput) attachInput(initialInput); // attaches listeners (input is null)
  console.log(`[revealyst] sidebar active on ${def.name} (input ${input ? "found" : "MISSING"})`);

  // LLM pages often replace the composer node while the app boots (e.g.
  // ChatGPT mounts a hidden a11y textarea before the visible ProseMirror
  // editor). Re-check periodically and re-attach so scoring survives such
  // swaps and SPA navigation (spec §7 resilience).
  setInterval(() => {
    const el = findInput(document, def);
    if (el && el !== input) attachInput(el);
  }, 2000);
}

void main();
