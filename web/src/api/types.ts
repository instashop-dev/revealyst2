/** Shared API response types (mirrors the Workers API contract). */

export interface User {
  id: string;
  email: string;
  plan: string;
  /** True when this account is the app creator (server ADMIN_EMAILS check). */
  is_admin: boolean;
}

export interface Session {
  token: string;
  user: User;
}

/** One row of the admin users list (app creator only). */
export interface AdminUser {
  id: string;
  email: string;
  plan: string;
  created_at: string;
  last_active_at: string | null;
  events_count: number;
  teams: Array<{ id: string; name: string; role: string }>;
}

export type TeamRole = "manager" | "member";

export interface Team {
  id: string;
  name: string;
  role: TeamRole;
  anonymize_identities: boolean;
}

export interface TeamMember {
  user_id: string;
  role: TeamRole;
  anon_alias: string | null;
  opt_in_identifiable: boolean;
  display_name: string;
}

export interface LibraryCard {
  id: string;
  title: string | null;
  tags: string[];
  score: number | null;
  usage_count: number;
  version: number;
  is_standard: boolean;
  notes: string | null;
  last_used_at: string | null;
  created_at: string;
  contributor: string;
}

export interface LibraryDetail {
  id: string;
  prompt_text: string;
  title: string | null;
  version: number;
}

export interface LibraryVersion {
  id: string;
  version: number;
  title: string | null;
  created_at: string;
  is_standard: boolean;
}

export interface DashboardResponse {
  team_id: string;
  period: string;
  avg_score: number | null;
  common_weaknesses: Array<{ flag: string; count: number }>;
  top_prompts: Array<{
    id: string;
    title: string | null;
    score: number | null;
    usage_count: number;
    version: number;
    is_standard: boolean;
    contributor: string;
    created_at: string;
  }>;
  volume_by_platform: Array<{ llm_platform: string | null; count: number }>;
  volume_by_day: Array<{ day: string; count: number }>;
  score_by_day: Array<{ day: string; avg_score: number }>;
  trends_by_user: Array<{ user: string; day: string; avg_score: number }>;
  identifiable: boolean;
}

export interface HistoryEvent {
  prompt_hash: string;
  score: number;
  breakdown: Record<string, number>;
  flags: string[];
  llm_platform: string | null;
  rating: number | null;
  created_at: string;
}

export interface HistoryResponse {
  events: HistoryEvent[];
  note: string;
}

export interface StatsResponse {
  period: string;
  prompts_count: number;
  green_count: number;
  avg_score: number | null;
  accepted_count: number;
  clarity_count: number;
  format_count: number;
  shared_count: number;
  streak_days: number;
  trend: Array<{ day: string; avg_score: number }>;
  radar: Record<string, number>;
  /** North-star instrumentation (spec §4): 4-week lift, re-prompt rate,
   *  weekly retention. Nulls when the user has no data in the window. */
  improvement: {
    pqs_delta_4w: number | null;
    current_avg: number | null;
    baseline_avg: number | null;
    reprompt_rate: number | null;
    reprompt_rate_prev: number | null;
    active_weeks: number;
  };
}

export interface ScoreEvent {
  prompt_hash: string;
  score: number;
  breakdown: Record<string, number>;
  flags: string[];
  llm_platform: string;
  created_at: string;
}
