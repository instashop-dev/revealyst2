/** Suggestion returned by the suggestion pipeline (spec §5.3). */
export interface Suggestion {
  id: string;
  type: string;
  text: string;
  preview: string;
  action: "prepend" | "append" | "insert";
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
}

export interface Settings {
  /** User paused scoring for this session (spec §5.1). */
  paused: boolean;
  /** Opt-in cloud sync for team analytics (default off, spec §5.1). */
  cloudSync: boolean;
  /** API base URL (overridable for local dev). */
  apiBase: string;
  /** Per-platform custom input selectors (spec: "plus any configurable list"). */
  platformSelectors: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  cloudSync: false,
  apiBase: "https://revealyst-workers.thapi.workers.dev",
  platformSelectors: {},
};

export interface OnboardingState {
  completed: boolean;
}

export const STORAGE_KEYS = {
  settings: "revealyst:settings",
  onboarding: "revealyst:onboarding",
  session: "revealyst:session",
  history: "revealyst:history",
} as const;
