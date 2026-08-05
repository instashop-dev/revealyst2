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
  readonly engineKind: "onnx" | "rules";
  private pipelinePromise: Promise<TransformersPipeline | null> | null = null;
  private readonly fallback = new RuleScoringEngine();

  constructor(private readonly config: OnnxModelConfig | null) {
    this.engineKind = config ? "onnx" : "rules";
  }

  async score(prompt: string, options?: ScoringOptions): Promise<ScoreResult> {
    const pipeline = await this.loadPipeline();
    if (!pipeline) {
      return this.fallback.score(prompt, options);
    }
    try {
      return await this.scoreWithModel(pipeline, prompt, options);
    } catch (error) {
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
      // Dynamic import with @vite-ignore so bundlers (Vite/CRXJS, esbuild) do
      // not try to statically resolve the optional peer at build time.
      const mod = (await import(/* @vite-ignore */ "@xenova/transformers")) as {
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
    const raw = await pipeline(prompt);
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
    for (const key of ["output", "logits", "scores", "values"]) {
      const v = (raw as Record<string, unknown>)[key];
      if (Array.isArray(v) && v.every((n) => typeof n === "number")) return v as number[];
    }
  }
  return null;
}

function toScale(n: number): number {
  const v = Math.abs(n) <= 1 ? n * 100 : 100 / (1 + Math.exp(-n));
  return Math.min(100, Math.max(0, v));
}
