import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnnxScoringAdapter } from "../src/onnx-adapter.js";

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
