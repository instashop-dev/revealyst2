/** Shared API response types (mirrors the Workers OpenAPI contract). */

export interface User {
  id: string;
  email: string;
  plan: string;
}

export interface Session {
  token: string;
  user: User;
}

export interface LibraryCard {
  id: string;
  title: string | null;
  tags: string[];
  score: number | null;
  usage_count: number;
  version: number;
  created_at: string;
  contributor: string;
}

export interface DashboardResponse {
  team_id: string;
  period: string;
  avg_score: number | null;
  common_weaknesses: Array<{ flag: string; count: number }>;
  top_prompts: Array<{ prompt_hash: string; best_score: number; occurrences: number }>;
  volume_by_platform: Array<{ llm_platform: string | null; count: number }>;
  volume_by_day: Array<{ day: string; count: number }>;
  trends_by_user: Array<{ user: string; day: string; avg_score: number }>;
}

export interface ScoreEvent {
  prompt_hash: string;
  score: number;
  breakdown: Record<string, number>;
  flags: string[];
  llm_platform: string;
  created_at: string;
}
