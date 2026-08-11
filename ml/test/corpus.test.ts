import { describe, expect, it } from "vitest";
import { generateCorpus, summarize } from "../src/generate-corpus";

describe("synthetic corpus generator", () => {
  it("is deterministic for a fixed seed", () => {
    const a = generateCorpus({ seed: 7, train: 300, eval: 100 });
    const b = generateCorpus({ seed: 7, train: 300, eval: 100 });
    expect(a).toHaveLength(400);
    expect(b).toHaveLength(400);
    expect(a.map((r) => `${r.id}:${r.prompt}:${r.score}`)).toEqual(
      b.map((r) => `${r.id}:${r.prompt}:${r.score}`),
    );
    // A different seed produces a different corpus.
    const c = generateCorpus({ seed: 8, train: 300, eval: 100 });
    expect(a[0]?.prompt).not.toBe(c[0]?.prompt);
  });

  it("labels every prompt with valid scores in 0..100", () => {
    const rows = generateCorpus({ seed: 1, train: 200, eval: 50 });
    for (const r of rows) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      for (const [dim, value] of Object.entries(r.breakdown)) {
        expect(value, `${r.id} ${dim}`).toBeGreaterThanOrEqual(0);
        expect(value, `${r.id} ${dim}`).toBeLessThanOrEqual(100);
      }
      expect(r.prompt).toBeTypeOf("string");
    }
  });

  it("spans the full score band (not degenerate)", () => {
    const rows = generateCorpus({ seed: 3, train: 2000, eval: 500 });
    const scores = rows.map((r) => r.score);
    const spread = Math.max(...scores) - Math.min(...scores);
    expect(spread).toBeGreaterThanOrEqual(40);
    // Every dimension should vary meaningfully, so the model has signal.
    for (const dim of Object.keys(rows[0]?.breakdown ?? {})) {
      const values = rows.map((r) => r.breakdown[dim as keyof typeof r.breakdown]);
      const range = Math.max(...values) - Math.min(...values);
      expect(range, dim).toBeGreaterThanOrEqual(30);
    }
  });

  it("includes edge cases: truncated long prompt and deficiency flags", () => {
    const rows = generateCorpus({ seed: 5, train: 500, eval: 100 });
    expect(rows.some((r) => r.meta.truncated)).toBe(true);
    expect(rows.some((r) => r.flags.includes("too_long"))).toBe(true);
    expect(rows.some((r) => r.flags.includes("low_specificity"))).toBe(true);
    expect(rows.some((r) => r.flags.includes("missing_role"))).toBe(true);
    const empty = rows.find((r) => r.prompt === "");
    expect(empty).toBeDefined();
  });

  it("produces the documented train/eval split", () => {
    const rows = generateCorpus({ seed: 2, train: 800, eval: 200 });
    expect(rows.filter((r) => r.split === "train")).toHaveLength(800);
    expect(rows.filter((r) => r.split === "eval")).toHaveLength(200);
  });

  it("summarize reports the corpus shape", () => {
    const rows = generateCorpus({ seed: 4, train: 100, eval: 25 });
    const summary = summarize(rows);
    expect(summary).toContain("125 prompts");
    expect(summary).toContain("score range:");
    expect(summary).toContain("dimension ranges:");
  });
});
