import { createScoringEngine } from "@revealyst/scoring";
import type { ScoringAdapter } from "@revealyst/scoring";

/**
 * Public base URL of the prompt-scorer-v1 artifact on Cloudflare R2.
 *
 * Set this to the bucket's r2.dev URL after the one-time public-access step
 * (docs/runbook.md → "ONNX prompt-scorer model"): R2 → revealyst-models →
 * Settings → Public access → copy the pub-<hash>.r2.dev URL.
 *
 * Until then the model cannot load and scoring transparently falls back to the
 * rule engine (spec §7: "Local model fails to load → rule-based scoring takes
 * over"). The placeholder is a safe default — never a broken feature.
 */
export const MODEL_BASE_URL = "https://pub-<hash>.r2.dev/prompt-scorer-v1";

/**
 * Build the scoring engine with the local ONNX scorer (spec §5.2):
 * a Transformers.js feature-extraction pipeline + the trained regression head
 * (head.json) loaded from MODEL_BASE_URL.
 *
 * The library is imported lazily with a literal specifier: Vite bundles it
 * into a separate chunk, but any load/init failure (offline, CSP, wasm,
 * page-context restrictions) happens on first score and is caught by the
 * adapter, which flips back to rules with a modelError — the sidebar is never
 * broken by the model path.
 */
export function createOnnxEngine(): ScoringAdapter {
  // While MODEL_BASE_URL is the unconfigured placeholder ("pub-<hash>"),
  // never attempt the model load: transformers.js init + a doomed fetch would
  // delay the first score. Score with the rule engine until the real URL is
  // set (docs/runbook.md → ONNX prompt-scorer model).
  if (MODEL_BASE_URL.includes("<")) {
    return createScoringEngine();
  }
  return createScoringEngine({
    modelId: MODEL_BASE_URL,
    task: "feature-extraction",
    quantized: true,
    pipelineFactory: async (task, modelId, options) => {
      const { pipeline } = await import("@xenova/transformers");
      // transformers.js types a union of task-specific pipelines; the adapter
      // only needs the generic call shape, so narrow it once here.
      const load = pipeline as unknown as (
        task: string,
        modelId: string,
        options?: { quantized?: boolean; revision?: string; pooling?: string },
      ) => Promise<(input: string, options?: unknown) => Promise<unknown>>;
      return load(task, modelId, options);
    },
  });
}
