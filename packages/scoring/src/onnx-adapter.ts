import { RuleScoringEngine, RULES_REVISION, deriveFlags } from "./rules.js";
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
  /** Hugging Face model id or absolute URL, e.g. "revealyst/prompt-scorer-v1"
   *  or "https://.../prompt-scorer-v1". */
  modelId: string;
  /**
   * Transformers.js task:
   *  - "text-classification" (default): the legacy contract — the pipeline
   *    output is parsed as 6 scores (probabilities or logits).
   *  - "feature-extraction": the trained scorer contract — the pipeline
   *    returns mean-pooled embeddings and the regression head (head.json,
   *    trained with the encoder) maps them to the 6 dims.
   */
  task?: string;
  /** int8 quantization; defaults to true (spec: quantized int8, ~80MB). */
  quantized?: boolean;
  revision?: string;
  /** URL of head.json for feature-extraction mode (default: `${modelId}/head.json`). */
  headUrl?: string;
  /** Inline regression head (tests / pre-fetched) — skips the headUrl fetch. */
  head?: OnnxHead;
  /**
   * Optional external pipeline factory. Bundlers cannot resolve the adapter's
   * dynamic `import("@xenova/transformers")` inside a bundled extension, so
   * the extension imports the library statically and injects it here. Falls
   * back to the dynamic import when absent.
   */
  pipelineFactory?: (
    task: string,
    modelId: string,
    options?: { quantized?: boolean; revision?: string; pooling?: string },
  ) => Promise<TransformersPipeline>;
}

/** Regression head trained alongside the encoder (see ml/python/train.py). */
export interface OnnxHead {
  /** [6][384] — one row per output dim. */
  weight: number[][];
  /** [6] bias per dim. */
  bias: number[];
  pooling?: "mean";
  activation?: "sigmoid";
  dim_names?: string[];
  /**
   * Rules revision the model was distilled from (ml/python/train.py writes
   * it, synced with RULES_REVISION in rules.ts). A model trained on an older
   * revision must not override the current rule heuristics, so the adapter
   * falls back to rules when this does not match. Absent = legacy artifact.
   */
  rules_rev?: number;
}

type TransformersPipeline = (input: string, options?: unknown) => Promise<unknown>;

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
  private headPromise: Promise<OnnxHead | null> | null = null;
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
    const {
      modelId,
      task = "text-classification",
      quantized = true,
      revision,
    } = this.config as OnnxModelConfig;
    const options = {
      quantized,
      revision,
      // feature-extraction: mean-pool token embeddings -> [1, dim] vector.
      pooling: task === "feature-extraction" ? "mean" : undefined,
    };
    const create = (): Promise<TransformersPipeline | null> => {
      if (this.config?.pipelineFactory) {
        return this.config.pipelineFactory(task, modelId, options);
      }
      return this.dynamicImportPipeline(task, modelId, options);
    };
    // A slow model host must never stall scoring: give the pipeline 15s to
    // load, then fall back to rules (spec §7).
    try {
      return await Promise.race([
        create(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
    } catch {
      return null;
    }
  }

  private async dynamicImportPipeline(
    task: string,
    modelId: string,
    options: { quantized?: boolean; revision?: string; pooling?: string },
  ): Promise<TransformersPipeline | null> {
    try {
      // Dynamic import via a variable specifier: TS/Vite do not statically
      // resolve it, so the optional @xenova/transformers peer can be absent at
      // build time and is loaded (or fails) at runtime.
      const specifier = "@xenova/transformers";
      const mod = (await import(/* @vite-ignore */ specifier)) as {
        pipeline?: (
          task: string,
          model: string,
          options?: { quantized?: boolean; revision?: string; pooling?: string },
        ) => Promise<TransformersPipeline>;
      };
      if (!mod.pipeline) return null;
      return await mod.pipeline(task, modelId, options);
    } catch {
      return null;
    }
  }

  /**
   * Contract for a fine-tuned prompt-scoring model: return 6 numbers in order
   * [overall, specificity, context, role_clarity, output_format,
   * examples_included]. Values in 0..1 are treated as probabilities (×100);
   * anything else as logits (sigmoid ×100).
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
    const raw = await pipeline(modelInput, { pooling: "mean" });

    const task = this.config?.task ?? "text-classification";
    if (task === "feature-extraction") {
      return this.scoreWithHead(raw, prompt, options);
    }

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
      // The model path never floors dimensions, so meta must not carry the
      // rule engine's flooredDims (the displayed breakdown is the model's).
      meta: {
        engine: "onnx",
        truncated: fallback.meta.truncated,
        estimatedTokens: fallback.meta.estimatedTokens,
        wordCount: fallback.meta.wordCount,
        charCount: fallback.meta.charCount,
      },
    };
  }

  /**
   * Trained-scorer path: mean-pooled embedding + sigmoid(linear) head
   * (weights in head.json, produced by ml/python/train.py). Outputs 6 values
   * in 0..1 that map directly to the 0-100 score scale.
   */
  private async scoreWithHead(
    raw: unknown,
    prompt: string,
    options?: ScoringOptions,
  ): Promise<ScoreResult> {
    const head = await this.loadHead();
    if (!head) throw new Error("regression head unavailable");
    if (head.rules_rev !== RULES_REVISION) {
      // The model is a distillation of the rule engine: a stale head would
      // silently keep the old (fixed) heuristics in production. Fall back to
      // the current rules until the model is retrained against this revision.
      throw new Error(
        `model out of date (rules rev ${head.rules_rev ?? "legacy"}, expected ${RULES_REVISION})`,
      );
    }
    const embedding = toFloatArray(raw);
    const expected = head.weight[0]?.length ?? 0;
    if (!embedding || expected === 0 || embedding.length !== expected) {
      throw new Error("unexpected embedding shape");
    }
    const values = head.weight.map((row, i) => {
      let logit = head.bias[i] ?? 0;
      for (let j = 0; j < row.length; j++) {
        logit += (row[j] ?? 0) * (embedding[j] ?? 0);
      }
      // Sigmoid -> 0..1 -> 0..100 (the model was trained on normalized labels).
      return Math.round((100 / (1 + Math.exp(-logit))) * 10) / 10;
    });
    const [overall, ...dimValues] = values;
    const breakdown = {} as Record<DimensionName, number>;
    DIMENSIONS.forEach((dim, i) => {
      breakdown[dim] = clampScore(dimValues[i] ?? 0);
    });
    const score = clampScore(overall ?? 0);
    const fallback = this.fallback.scoreSync(prompt, options);
    const flags = deriveFlags(breakdown, fallback.meta);
    return {
      score,
      breakdown,
      flags,
      // The model path never floors dimensions, so meta must not carry the
      // rule engine's flooredDims (the displayed breakdown is the model's).
      meta: {
        engine: "onnx",
        truncated: fallback.meta.truncated,
        estimatedTokens: fallback.meta.estimatedTokens,
        wordCount: fallback.meta.wordCount,
        charCount: fallback.meta.charCount,
      },
    };
  }

  private loadHead(): Promise<OnnxHead | null> {
    if (this.config?.head) return Promise.resolve(this.config.head);
    if (!this.headPromise) {
      this.headPromise = this.tryFetchHead();
    }
    return this.headPromise;
  }

  private async tryFetchHead(): Promise<OnnxHead | null> {
    if (!this.config) return null;
    const url = this.config.headUrl ?? `${this.config.modelId}/head.json`;
    try {
      // A hung model host must never stall scoring once the pipeline loaded.
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const head = (await res.json()) as OnnxHead;
      return Array.isArray(head.weight) && Array.isArray(head.bias) ? head : null;
    } catch {
      return null;
    }
  }
}

/** Flatten a Transformers.js Tensor / typed array / nested array to numbers. */
function toFloatArray(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
    const data = (raw as { data: unknown }).data;
    if (ArrayBuffer.isView(data)) return Array.from(data as unknown as ArrayLike<number>);
  }
  if (Array.isArray(raw)) {
    if (raw.every((v) => typeof v === "number")) return raw as number[];
    const flattened = raw.flat(Infinity);
    if (flattened.every((v) => typeof v === "number")) return flattened as number[];
  }
  if (ArrayBuffer.isView(raw)) return Array.from(raw as unknown as ArrayLike<number>);
  return null;
}

function clampScore(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
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
