import { describe, expect, it } from "vitest";
import { RuleScoringEngine } from "../src/index";

const engine = new RuleScoringEngine();

const samplePrompt =
  "Act as a product manager. Draft a short changelog entry for our analytics dashboard, " +
  "mentioning the new usage reports for our 2000 customers, in 100 words with bullet points. " +
  "Our team uses this daily to track feature adoption. For example: like our last release note. " +
  "Keep it friendly but professional.";

describe("scoring performance (spec: local scoring < 200ms)", () => {
  it("scores 200 iterations well under 200ms each", () => {
    const iterations = 200;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      engine.scoreSync(samplePrompt);
    }
    const elapsed = performance.now() - start;
    const perScore = elapsed / iterations;
    // Rule engine is microsecond-fast; assert a generous upper bound to keep
    // the CI environment from flaking while still catching regressions.
    expect(perScore).toBeLessThan(5);
  });

  it("resolves the async adapter contract quickly", async () => {
    const start = performance.now();
    await engine.score(samplePrompt);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
