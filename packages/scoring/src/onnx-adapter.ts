import { RuleScoringEngine, deriveFlags } from "./rules.js";
import type { ScoringAdapter } from "./adapter.js";
import type { ScoreResult, ScoringOptions } from "./types.js";
import { DIMENSIONS } from "./types.js";
import type { DimensionName } from "./types.js";

/**
 * Configuration for the optional in-browser ONNX scoring model
 * (spec §5.2: fine-tuned DistilBERT exported to ONNX, run via Transformers.js).
 * No model artifact is shipped yet — see ml/ training notes — so until a real
 * model is supplied this adapter transparently falls back to the rule engine.
 */
export interface OnnxModelConfig {
  /** Hugging Face model id, e.g. "revealyst/prompt-scorer-v1". */
  modelId: string;
  /** Transformers.js task; defaults to "text-classification". */
  task?: string;
  /** int8 quantization; defaults to true (spec: quantized int8, ~80MB). */
  quantized?: boolean;
  revision?: string;
}

type TransformersPipeline = (input: string) => Promise<unknown>;

/**
 * Adapter that loads a Transformers.js pipeline (dynamic import of the
 * optional `@xenova/transformers` peer) and maps the model output to a
 * ScoreResult. Falls back to the rule engine whenever the model cannot be
 * loaded or its output is unexpected, exactly per spec §5.2 ("Fallback: if the
 * local model fails to load, rule-based scoring takes over").
 */
export class OnnxScoringAdapter implements ScoringAdapter {
  /** Effective engine kind — flips to "rules" once a model failure forces a
   *  fallback, so consumers can show the spec §7 "model unavailable" warning. */
  engineKind: "onnx" | "rules";
  private pipelinePromise: Promise<TransformersPipeline | null> | null = null;
  private readonly fallback = new RuleScoringEngine();

  constructor(private readonly config: OnnxModelConfig | null) {
    this.engineKind = config ? "onnx" : "rules";
  }

  async score(prompt: string, options?: ScoringOptions): Promise<ScoreResult> {
    const pipeline = await this.loadPipeline();
    if (!pipeline) {
      this.engineKind = "rules";
      return this.fallback.score(prompt, options);
    }
    try {
      const result = await this.scoreWithModel(pipeline, prompt, options);
      this.engineKind = "onnx";
      return result;
    } catch (error) {
      this.engineKind = "rules";
      const result = await this.fallback.score(prompt, options);
      return {
        ...result,
        meta: {
          ...result.meta,
          modelError: error instanceof Error ? error.message : "model_inference_failed",
        },
      };
    }
  }

  private loadPipeline(): Promise<TransformersPipeline | null> {
    if (!this.config) return Promise.resolve(null);
    if (!this.pipelinePromise) {
      this.pipelinePromise = this.tryLoad();
    }
    return this.pipelinePromise;
  }

  private async tryLoad(): Promise<TransformersPipeline | null> {
    try {
      // Dynamic import via a variable specifier: TS/Vite do not statically
      // resolve it, so the optional @xenova/transformers peer can be absent at
      // build time and is loaded (or fails) at runtime.
      const specifier = "@xenova/transformers";
      const mod = (await import(/* @vite-ignore */ specifier)) as {
        pipeline?: (
          task: string,
          model: string,
          options?: { quantized?: boolean; revision?: string },
        ) => Promise<TransformersPipeline>;
      };
      if (!mod.pipeline) return null;
      const {
        modelId,
        task = "text-classification",
        quantized = true,
        revision,
      } = this.config as OnnxModelConfig;
      return await mod.pipeline(task, modelId, { quantized, revision });
    } catch {
      return null;
    }
  }

  /**
   * Contract for a fine-tuned prompt-scoring model: given the prompt, return a
   * shape containing 6 numbers in order [overall, specificity, context,
   * role_clarity, output_format, examples_included]. Values in 0..1 are
   * treated as probabilities (×100); anything else as logits (sigmoid ×100).
   */
  private async scoreWithModel(
    pipeline: TransformersPipeline,
    prompt: string,
    options?: ScoringOptions,
  ): Promise<ScoreResult> {
    // Spec §7: prompts >4000 estimated tokens are truncated to the first 1000
    // characters before scoring — the model input too, not just the rules.
    const { maxTokens = 4000, truncateTo = 1000 } = options ?? {};
    const estimatedTokens = Math.ceil(prompt.length / 4);
    const modelInput = estimatedTokens > maxTokens ? prompt.slice(0, truncateTo) : prompt;
    const raw = await pipeline(modelInput);
    const values = extractValues(raw);
    if (!values || values.length < DIMENSIONS.length + 1) {
      throw new Error("unexpected model output shape");
    }
    const [overall, ...dimValues] = values;
    const breakdown = {} as Record<DimensionName, number>;
    DIMENSIONS.forEach((dim, i) => {
      breakdown[dim] = Math.round(toScale(dimValues[i] ?? 0));
    });
    const score = Math.round(toScale(overall ?? 0));
    const fallback = this.fallback.scoreSync(prompt, options);
    const flags = deriveFlags(breakdown, fallback.meta);
    return {
      score,
      breakdown,
      flags,
      meta: { ...fallback.meta, engine: "onnx" },
    };
  }
}

function extractValues(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    if (raw.every((v) => typeof v === "number")) return raw as number[];
    // [{label, score}] style classifier output
    const scores = raw.map((r) =>
      typeof r === "object" && r !== null && "score" in r
        ? Number((r as { score: unknown }).score)
        : NaN,
    );
    return scores.some(Number.isNaN) ? null : scores;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["output", "logits", "scores", "values"]) {
      const v = obj[key];
      if (Array.isArray(v)) {
        // Nested array of numbers, or [{label, score}] (token-level outputs).
        if (v.every((n) => typeof n === "number")) return v as number[];
        const nested = extractValues(v);
        if (nested) return nested;
      }
    }
    // Single-label text-classification output: {label: "LABEL_0", score: 0.9}.
    // A single scalar cannot fill the 6-value contract, but a single-value
    // classifier is a legitimate (if coarse) model — map it to overall only
    // and let the caller's shape check decide (dimensions fall back to rules).
    if (typeof obj.label === "string" && typeof obj.score === "number") {
      return [obj.score];
    }
    if (typeof obj.score === "number" && "label" in obj === false) {
      return [obj.score];
    }
  }
  return null;
}

function toScale(n: number): number {
  const v = Math.abs(n) <= 1 ? n * 100 : 100 / (1 + Math.exp(-n));
  return Math.min(100, Math.max(0, v));
}
