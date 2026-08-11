import { RuleScoringEngine } from "./rules.js";
import { OnnxScoringAdapter } from "./onnx-adapter.js";
import type { OnnxModelConfig } from "./onnx-adapter.js";
import type { ScoringAdapter } from "./adapter.js";

/**
 * @revealyst/scoring — self-contained prompt scoring engine.
 *
 * Framework-free module usable from the Chrome extension (content script /
 * service worker) and the web app. Rule-based scoring is the working engine;
 * an ONNX/Transformers.js adapter is wired for a future fine-tuned model and
 * falls back to rules whenever the model is unavailable (spec §5.2).
 */
export * from "./types.js";
export * from "./flags.js";
export {
  RuleScoringEngine,
  RULES_REVISION,
  deriveFlags,
  estimateTokens,
  scoreSpecificity,
  scoreContext,
  scoreRoleClarity,
  scoreOutputFormat,
  scoreExamples,
  classifyTask,
  applyTaskFloors,
} from "./rules.js";
export type { TaskKind } from "./rules.js";
export { OnnxScoringAdapter } from "./onnx-adapter.js";
export type { OnnxModelConfig } from "./onnx-adapter.js";
export type { ScoringAdapter } from "./adapter.js";

export const scoringEngineName = "revealyst-scoring";

/** Factory: pass an ONNX model config to opt into the model path (with rule
 * fallback); pass nothing for pure rule-based scoring. */
export function createScoringEngine(config?: OnnxModelConfig | null): ScoringAdapter {
  return config ? new OnnxScoringAdapter(config) : new RuleScoringEngine();
}
