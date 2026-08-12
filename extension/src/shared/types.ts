/** Suggestion returned by the suggestion pipeline (spec §5.3). */
export interface Suggestion {
  id: string;
  type: string;
  text: string;
  preview: string;
  action: "prepend" | "append" | "insert";
  /** Advisory suggestions carry coaching text but no auto-inserted preview —
   *  the sidebar shows them without an Apply button. */
  advisory?: boolean;
}

export interface SuggestionResponse {
  suggestions: Suggestion[];
  source: "vectorize+llm" | "static";
}

export interface ScoreEventPayload {
  prompt_hash: string;
  score: number;
  flags: string[];
  breakdown: Record<string, number>;
  llm_platform: string;
  team_id?: string;
  user_anon_id?: string;
  /** Thumbs up/down for this prompt (-1 | 0 | 1) — spec §5.4 history rating. */
  rating?: number;
}

export interface Settings {
  /** User paused scoring for this session (spec §5.1). */
  paused: boolean;
  /** Opt-in cloud sync for team analytics (default off, spec §5.1). */
  cloudSync: boolean;
  /** API base URL (overridable for local dev). */
  apiBase: string;
  /** Session token copied from the web dashboard Settings — authorises
   *  save-to-library and suggestion feedback (spec §5.1/§5.6). */
  apiToken: string;
  /** Email of the account the apiToken belongs to (action popup display). */
  accountEmail: string;
  /** Team the user saves library prompts into (spec §5.5 promote-to-library). */
  teamId: string;
  /** Stable per-install anonymous id — groups team trends before sign-in
   *  while keeping the identity private (spec §5.5 pseudonyms). */
  anonId: string;
  /** Sidebar collapsed to a slim tab (persisted; user can restore anytime). */
  sidebarCollapsed: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  cloudSync: false,
  apiBase: "https://revealyst-workers.thapi.workers.dev",
  apiToken: "",
  accountEmail: "",
  teamId: "",
  anonId: "",
  sidebarCollapsed: false,
};

export interface OnboardingState {
  completed: boolean;
}

/** One locally-persisted scored prompt (spec §5.1 "view personal prompt
 *  history"; snippets never leave the device — privacy-first §5.7). */
export interface LocalHistoryEntry {
  prompt: string;
  score: number;
  flags: string[];
  platform: string;
  rating: number | null;
  createdAt: string;
}

/** One coaching tip for a single deficiency flag (see clientTipsFor). */
interface FlagTip {
  flag: string;
  make: () => Suggestion;
}

const ROLE_TIP: Suggestion = {
  // Advisory: the extension never sees the task, so it never fabricates a
  // role ("Act as a QA specialist") — the user completes the role themselves.
  id: "add_role",
  type: "add_role",
  text: "Say what perspective the AI should take — for example the role, the reader, or the goal you want the response to serve.",
  preview: "",
  action: "append",
  advisory: true,
};

const OUTPUT_FORMAT_TIP: Suggestion = {
  id: "add_output_format",
  type: "add_output_format",
  text: 'Tell the AI exactly how to respond, e.g. "Answer as a bulleted list."',
  preview: "Answer as a bulleted list. ",
  action: "append",
};

const CONTEXT_TIP: Suggestion = {
  id: "add_context",
  type: "add_context",
  text: "Add who it is for, why you need it, and what you already know.",
  preview:
    " Add 2-3 sentences of background: who this is for, why you need it, and what you already know.",
  action: "append",
};

function makeSpecificityTip(): Suggestion {
  return {
    id: "add_specifics",
    type: "add_specifics",
    text: "Replace vague words with concrete details — names, numbers, and exact requirements.",
    preview: " Add concrete details: names, numbers, and exact requirements. ",
    action: "append",
  };
}

function makeExamplesTip(): Suggestion {
  return {
    id: "add_examples",
    type: "add_examples",
    text: "Add an example so the AI can match the style, tone or output you want.",
    preview: " Include an example of the style or tone you want. ",
    action: "append",
  };
}

function makeShortTip(): Suggestion {
  return {
    id: "add_details",
    type: "add_details",
    text: "Expand the prompt: say who it is for, what you need, and any constraints.",
    preview: " Expand this with details: who it is for, what you need, and any constraints. ",
    action: "append",
  };
}

/**
 * Client-side static tips (spec §7): shown when the suggestion network
 * request fails and no server fallback is reachable. Flag-aware — only tips
 * that match the prompt's actual deficiencies are returned, so a green prompt
 * never gets "Answer as a bulleted list" and the examples/specificity
 * dimensions are coached too (previously a fixed 3-tip list covered only
 * role/format/context). At most 3, spread across distinct deficiencies;
 * actionable tips (with an Apply preview) come before the advisory role tip.
 */
export function clientTipsFor(flags: string[]): Suggestion[] {
  const flagSet = new Set(flags);
  const tips: Suggestion[] = [];
  const byFlag: FlagTip[] = [
    { flag: "too_short", make: makeShortTip },
    { flag: "low_specificity", make: makeSpecificityTip },
    { flag: "vague_context", make: () => CONTEXT_TIP },
    { flag: "missing_context", make: () => CONTEXT_TIP },
    { flag: "missing_output_format", make: () => OUTPUT_FORMAT_TIP },
    { flag: "no_examples", make: makeExamplesTip },
    { flag: "missing_role", make: () => ROLE_TIP },
  ];
  for (const { flag, make } of byFlag) {
    if (!flagSet.has(flag)) continue;
    const tip = make();
    // vague_context + missing_context share one context tip — never show it
    // twice.
    if (tips.some((t) => t.id === tip.id)) continue;
    tips.push(tip);
    if (tips.length >= 3) break;
  }
  return tips;
}

export const STORAGE_KEYS = {
  settings: "revealyst:settings",
  onboarding: "revealyst:onboarding",
  history: "revealyst:history",
} as const;

/** The hosted web dashboard (single source of truth for the URL). */
export const DASHBOARD_URL = "https://revealyst-web.pages.dev";
