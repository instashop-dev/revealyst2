import type { FlagName } from "./flags.js";

/** The five scored dimensions, matching the product spec's breakdown object. */
export const DIMENSIONS = [
  "specificity",
  "context",
  "role_clarity",
  "output_format",
  "examples_included",
] as const;

export type DimensionName = (typeof DIMENSIONS)[number];

export type ScoreBreakdown = Record<DimensionName, number>;

/** Score colour bands per the spec: red 0-49, yellow 50-69, green 70-100. */
export type ScoreBand = "red" | "yellow" | "green";

export const RED_MAX = 49;
export const YELLOW_MAX = 69;

export function bandFor(score: number): ScoreBand {
  if (score <= RED_MAX) return "red";
  if (score <= YELLOW_MAX) return "yellow";
  return "green";
}

export interface ScoreMeta {
  /** Which engine produced the score. */
  engine: "rules" | "onnx";
  /** True when the prompt exceeded maxTokens and was truncated for scoring. */
  truncated: boolean;
  /** Estimated token count (chars / 4). */
  estimatedTokens: number;
  wordCount: number;
  charCount: number;
  /** Set when the ONNX model path was attempted but failed. */
  modelError?: string;
}

/**
 * Result of scoring one prompt. `score` is 0-100; `breakdown` holds the five
 * dimension scores; `flags` are the canonical, machine-readable deficiency
 * names consumed by the suggestion engine and dashboards.
 */
export interface ScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
  flags: FlagName[];
  meta: ScoreMeta;
}

export interface ScoringOptions {
  /** Token threshold past which the prompt is truncated (default 4000). */
  maxTokens?: number;
  /** Characters kept when truncating (default 1000). */
  truncateTo?: number;
}
