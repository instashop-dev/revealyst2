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

/** Client-side static tips (spec §7): shown when the suggestion network
 *  request fails and no server fallback is reachable. */
export const CLIENT_TIPS: Suggestion[] = [
  {
    // Advisory: the extension never sees the task, so it never fabricates a
    // role ("Act as a QA specialist") — the user completes the role themselves.
    id: "add_role",
    type: "add_role",
    text: "Say what perspective the AI should take — for example the role, the reader, or the goal you want the response to serve.",
    preview: "",
    action: "append",
    advisory: true,
  },
  {
    id: "add_output_format",
    type: "add_output_format",
    text: 'Tell the AI exactly how to respond, e.g. "Answer as a bulleted list."',
    preview: "Answer as a bulleted list. ",
    action: "append",
  },
  {
    id: "add_context",
    type: "add_context",
    text: "Add who it is for, why you need it, and what you already know.",
    preview:
      " Add 2-3 sentences of background: who this is for, why you need it, and what you already know.",
    action: "append",
  },
];

export const STORAGE_KEYS = {
  settings: "revealyst:settings",
  onboarding: "revealyst:onboarding",
  session: "revealyst:session",
  history: "revealyst:history",
} as const;

/** The hosted web dashboard (single source of truth for the URL). */
export const DASHBOARD_URL = "https://revealyst-web.pages.dev";
