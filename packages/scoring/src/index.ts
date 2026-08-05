/**
 * @revealyst/scoring — self-contained prompt scoring engine.
 *
 * Phase 1 scaffold: the real rule-based engine and ONNX adapter land in Phase 2.
 * The module is intentionally framework-free so both the Chrome extension
 * (content script / service worker) and the web app can import it.
 */
export const scoringEngineName = "revealyst-scoring";

export interface ScoreBreakdown {
  specificity: number;
  context: number;
  role_clarity: number;
  output_format: number;
  examples_included: number;
}

export interface ScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
  flags: string[];
}
