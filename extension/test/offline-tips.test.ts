import { describe, expect, it } from "vitest";
import { clientTipsFor } from "../src/shared/types.js";

describe("clientTipsFor (offline fallback, PMF review)", () => {
  it("returns no tips for a prompt with no deficiencies", () => {
    // Previously a green prompt could still get "Answer as a bulleted list" —
    // the fallback list was fixed and never flag-aware.
    expect(clientTipsFor([])).toHaveLength(0);
  });

  it("matches tips to the prompt's actual flags", () => {
    const tips = clientTipsFor(["low_specificity", "no_examples"]);
    const ids = tips.map((t) => t.id);
    expect(ids).toContain("add_specifics");
    expect(ids).toContain("add_examples");
    expect(ids).not.toContain("add_output_format");
    expect(ids).not.toContain("add_role");
  });

  it("caps at 3 and never repeats a tip", () => {
    const tips = clientTipsFor([
      "too_short",
      "low_specificity",
      "vague_context",
      "missing_output_format",
      "no_examples",
      "missing_role",
    ]);
    expect(tips.length).toBeLessThanOrEqual(3);
    expect(new Set(tips.map((t) => t.id)).size).toBe(tips.length);
  });

  it("dedupes vague_context + missing_context into one context tip", () => {
    const tips = clientTipsFor(["vague_context", "missing_context"]);
    expect(tips.filter((t) => t.id === "add_context")).toHaveLength(1);
  });

  it("puts actionable tips before the advisory role tip", () => {
    const tips = clientTipsFor(["missing_role", "missing_output_format"]);
    expect(tips[0]!.advisory).not.toBe(true);
    expect(tips.some((t) => t.id === "add_role")).toBe(true);
  });

  it("shows only the advisory role tip when that is the only flag", () => {
    const tips = clientTipsFor(["missing_role"]);
    expect(tips).toHaveLength(1);
    expect(tips[0]!.id).toBe("add_role");
    expect(tips[0]!.advisory).toBe(true);
  });

  it("every tip has a valid action and no placeholder previews", () => {
    const flags = [
      "too_short",
      "low_specificity",
      "vague_context",
      "missing_output_format",
      "no_examples",
      "missing_role",
    ];
    for (const tip of clientTipsFor(flags)) {
      expect(["prepend", "append", "insert"]).toContain(tip.action);
      // Advisory tips may have an empty preview; everything else must be
      // insertable and placeholder-free (the Apply button inserts it).
      if (!tip.advisory) {
        expect(tip.preview.length).toBeGreaterThan(0);
        expect(tip.preview).not.toMatch(/\[|\]|\{|\}|\.\.\.|…/);
      }
    }
  });
});
