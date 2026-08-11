import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnnxScoringAdapter } from "../src/onnx-adapter.js";
import { RULES_REVISION } from "../src/rules.js";

/**
 * ONNX adapter output-contract tests (spec §5.2 + §7). The optional
 * @xenova/transformers peer is mocked so the model path can be exercised
 * without shipping a real (80MB) artifact.
 */

const MODEL_ID = "revealyst/prompt-scorer-v1";

/** Shared mutable output so re-imports of the mocked module read current state. */
let currentOutput: unknown;
let pipelineCalls: unknown[];
const pipeline = vi.fn(async (input: string) => {
  pipelineCalls.push(input);
  return currentOutput;
});

beforeEach(() => {
  currentOutput = null;
  pipelineCalls = [];
  pipeline.mockClear();
});

async function adapterFor(output: unknown): Promise<OnnxScoringAdapter> {
  currentOutput = output;
  return new OnnxScoringAdapter({ modelId: MODEL_ID, quantized: true });
}

describe("OnnxScoringAdapter model output contract", () => {
  it("parses the 6-value array contract [overall, specificity, context, role_clarity, output_format, examples_included]", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    const adapter = await adapterFor([0.8, 0.9, 0.6, 0.95, 0.4, 0.1]);
    const result = await adapter.score("Act as a marketer. Write a cold email in under 100 words.");
    expect(result.meta.engine).toBe("onnx");
    expect(adapter.engineKind).toBe("onnx");
    expect(result.score).toBe(80);
    expect(result.breakdown).toEqual({
      specificity: 90,
      context: 60,
      role_clarity: 95,
      output_format: 40,
      examples_included: 10,
    });
    // Truncation contract (§7): >4000 estimated tokens → first 1000 chars reaches the model.
    await adapter.score("x".repeat(17_000)); // ≈4250 tokens > 4000
    expect(pipelineCalls[pipelineCalls.length - 1]).toBe("x".repeat(1000));
    expect(pipelineCalls[0]).toBe("Act as a marketer. Write a cold email in under 100 words.");
  });

  it("parses nested {output: [{label, score}]} and {scores: [...]} shapes", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    const nested = await adapterFor({ output: [{ label: "LABEL_0", score: 0.9 }] });
    // 1 value < 6 → clean fallback (shape error), not a crash.
    expect((await nested.score("hi")).meta.engine).toBe("rules");

    const objectScores = await adapterFor({ scores: [0.7, 0.8, 0.5, 0.6, 0.3, 0.2] });
    expect((await objectScores.score("hi")).meta.engine).toBe("onnx");
  });

  it("falls back to rules with a modelError when inference throws", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    const adapter = await adapterFor(null);
    pipeline.mockRejectedValueOnce(new Error("inference boom"));
    const result = await adapter.score("Help me write something good.");
    expect(result.meta.engine).toBe("rules");
    expect(result.meta.modelError).toBe("inference boom");
    expect(adapter.engineKind).toBe("rules");
  });
});

describe("OnnxScoringAdapter feature-extraction + regression head (prompt-scorer-v1)", () => {
  const DIM = 384;
  /** One-hot embedding [1,0,0,...] so head math is checkable by hand. */
  function oneHotEmbedding(): number[] {
    const e = new Array<number>(DIM).fill(0);
    e[0] = 1;
    return e;
  }
  const head = {
    weight: Array.from({ length: 6 }, (_, i) => {
      const row = new Array<number>(DIM).fill(0);
      row[i] = i === 0 ? 1 : 0; // only overall gets signal; others -> logit 0
      return row;
    }),
    bias: new Array<number>(6).fill(0),
    pooling: "mean" as const,
    activation: "sigmoid" as const,
    rules_rev: RULES_REVISION,
    dim_names: [
      "overall",
      "specificity",
      "context",
      "role_clarity",
      "output_format",
      "examples_included",
    ],
  };

  beforeEach(() => {
    pipeline.mockClear();
  });

  it("computes the 6 dims via sigmoid(linear head) on the pooled embedding", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    currentOutput = oneHotEmbedding();
    const adapter = new OnnxScoringAdapter({
      modelId: "https://models.example.com/prompt-scorer-v1",
      task: "feature-extraction",
      quantized: true,
      head,
    });
    const result = await adapter.score("Act as a marketer. Write a cold email in under 100 words.");
    expect(result.meta.engine).toBe("onnx");
    expect(adapter.engineKind).toBe("onnx");
    // overall: sigmoid(1*1+0)=0.731 -> 73.1; dims: sigmoid(0)=0.5 -> 50.
    expect(result.score).toBe(73);
    expect(result.breakdown).toEqual({
      specificity: 50,
      context: 50,
      role_clarity: 50,
      output_format: 50,
      examples_included: 50,
    });
    // Truncation contract still applies to the model input.
    await adapter.score("y".repeat(17_000));
    expect(pipeline.mock.calls[pipeline.mock.calls.length - 1]?.[0]).toBe("y".repeat(1000));
  });

  it("accepts a Tensor-shaped embedding ({data: Float32Array})", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    currentOutput = { data: new Float32Array(oneHotEmbedding()), dims: [1, DIM] };
    const adapter = new OnnxScoringAdapter({
      modelId: "revealyst/prompt-scorer-v1",
      task: "feature-extraction",
      head,
    });
    const result = await adapter.score("Explain quantum computing to beginners.");
    expect(result.meta.engine).toBe("onnx");
    expect(result.score).toBe(73);
  });

  it("falls back to rules when the head cannot be fetched (offline / 404)", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    currentOutput = oneHotEmbedding();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unreachable")));
    try {
      const adapter = new OnnxScoringAdapter({
        modelId: "https://models.example.com/prompt-scorer-v1",
        task: "feature-extraction",
      });
      const result = await adapter.score("Help me with my thing.");
      expect(result.meta.engine).toBe("rules");
      expect(result.meta.modelError).toContain("regression head unavailable");
      expect(adapter.engineKind).toBe("rules");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to rules on a wrong embedding shape", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    currentOutput = new Array<number>(16).fill(0); // not 384
    const adapter = new OnnxScoringAdapter({
      modelId: "revealyst/prompt-scorer-v1",
      task: "feature-extraction",
      head,
    });
    const result = await adapter.score("hi");
    expect(result.meta.engine).toBe("rules");
    expect(result.meta.modelError).toBe("unexpected embedding shape");
  });

  it("falls back to rules when the head was distilled from an older rules revision", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    currentOutput = oneHotEmbedding();
    const staleHead = { ...head, rules_rev: (RULES_REVISION - 1) as number };
    const adapter = new OnnxScoringAdapter({
      modelId: "revealyst/prompt-scorer-v1",
      task: "feature-extraction",
      head: staleHead,
    });
    const result = await adapter.score("Help me write something good.");
    expect(result.meta.engine).toBe("rules");
    expect(result.meta.modelError).toContain("model out of date");
    expect(adapter.engineKind).toBe("rules");
  });

  it("falls back to rules when the head has no rules_rev (legacy artifact)", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    currentOutput = oneHotEmbedding();
    const { rules_rev, ...legacyHead } = head;
    void rules_rev;
    const adapter = new OnnxScoringAdapter({
      modelId: "revealyst/prompt-scorer-v1",
      task: "feature-extraction",
      head: legacyHead,
    });
    const result = await adapter.score("Help me write something good.");
    expect(result.meta.engine).toBe("rules");
    expect(result.meta.modelError).toContain("legacy");
  });

  it("uses an injected pipelineFactory instead of the dynamic import", async () => {
    vi.doMock("@xenova/transformers", () => ({ pipeline: async () => pipeline }));
    currentOutput = oneHotEmbedding();
    const factory = vi.fn(async () => pipeline);
    const adapter = new OnnxScoringAdapter({
      modelId: "https://models.example.com/prompt-scorer-v1",
      task: "feature-extraction",
      head,
      pipelineFactory: factory,
    });
    const result = await adapter.score("Help me.");
    expect(result.meta.engine).toBe("onnx");
    expect(factory).toHaveBeenCalledWith(
      "feature-extraction",
      "https://models.example.com/prompt-scorer-v1",
      expect.objectContaining({ quantized: true, pooling: "mean" }),
    );
  });

  it("falls back to rules when the injected pipelineFactory throws", async () => {
    const adapter = new OnnxScoringAdapter({
      modelId: "https://models.example.com/prompt-scorer-v1",
      task: "feature-extraction",
      head,
      pipelineFactory: async () => {
        throw new Error("transformers.js unavailable");
      },
    });
    const result = await adapter.score("Help me.");
    expect(result.meta.engine).toBe("rules");
    expect(adapter.engineKind).toBe("rules");
  });
});
