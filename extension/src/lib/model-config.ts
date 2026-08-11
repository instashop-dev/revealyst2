import { createScoringEngine } from "@revealyst/scoring";
import type { ScoringAdapter } from "@revealyst/scoring";

/**
 * Public base URL of the prompt-scorer-v1 artifact on Cloudflare R2.
 *
 * Served by the API worker's GET /models/* route (R2 binding → the
 * revealyst-models bucket). The files are fetched by Transformers.js at
 * runtime; the scorer is a public rule distillation with no sensitive data.
 *
 * If the route/URL changes, update docs/runbook.md → "ONNX prompt-scorer
 * model" to match.
 */
export const MODEL_BASE_URL = "https://revealyst-workers.thapi.workers.dev/models/prompt-scorer-v1";

/**
 * Transformers.js model id. The library resolves remote models as
 * `<env.remoteHost>/<modelId>/resolve/<revision>/<file>` (HF-style), so the
 * model id is the bare artifact name and `env.remoteHost` points at the
 * worker's /models root (which strips the /resolve/<rev> segment).
 */
export const MODEL_ID = "prompt-scorer-v1";

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
  return createScoringEngine({
    modelId: MODEL_ID,
    task: "feature-extraction",
    quantized: true,
    headUrl: `${MODEL_BASE_URL}/head.json`,
    pipelineFactory: async (task, modelId, options) => {
      const { pipeline, env } = await import("@xenova/transformers");
      // Point the library at the worker-served artifact root (HF-style
      // resolution: <remoteHost>/<modelId>/resolve/<revision>/<file>).
      env.allowRemoteModels = true;
      env.remoteHost = MODEL_BASE_URL.replace(/\/prompt-scorer-v1\/?$/, "");
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
