/** Row shapes returned by the repositories (PostgreSQL column names). */

export interface UserRow {
  id: string;
  email: string;
  created_at: string;
  plan: string;
  personal_score_trend: unknown;
  preferences: Record<string, unknown>;
}

export interface TeamRow {
  id: string;
  name: string;
  created_by: string | null;
  billing_status: string;
  settings: Record<string, unknown>;
  created_at: string;
}

export interface TeamMemberRow {
  team_id: string;
  user_id: string;
  role: string;
  anon_alias: string | null;
  opt_in_identifiable: boolean;
}

export interface PromptEventRow {
  id: string;
  user_anon_id: string;
  user_id: string | null;
  team_id: string | null;
  prompt_hash: string;
  score: number | null;
  breakdown: Record<string, number> | null;
  flags: string[] | null;
  llm_platform: string | null;
  created_at: string;
}

export interface LibraryPromptRow {
  id: string;
  team_id: string;
  title: string | null;
  prompt_text_encrypted: string;
  prompt_hash: string;
  tags: string[] | null;
  created_by: string | null;
  score: number | null;
  usage_count: number;
  version: number;
  parent_id: string | null;
  notes: string | null;
  is_standard: boolean;
  last_used_at: string | null;
  created_at: string;
}

export interface SuggestionFeedbackRow {
  user_id: string;
  suggestion_id: string;
  was_accepted: boolean;
  created_at: string;
}

export interface MagicLinkTokenRow {
  jti: string;
  user_id: string;
  expires_at: string;
}
