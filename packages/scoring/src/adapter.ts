import type { ScoreResult, ScoringOptions } from "./types.js";

/**
 * A scoring backend. Implementations must be stateless and safe to share;
 * `score()` must resolve quickly (rule engine: <200ms guaranteed; model
 * adapters fall back to rules when the model is unavailable).
 */
export interface ScoringAdapter {
  readonly engineKind: "rules" | "onnx";
  score(prompt: string, options?: ScoringOptions): Promise<ScoreResult>;
}
