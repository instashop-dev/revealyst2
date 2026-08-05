import { describe, expect, it } from "vitest";
import { generatePatterns } from "../src/generate.js";
import { CONTEXTS, EXAMPLES, FORMATS, ROLES, TOPICS } from "../src/templates.js";

describe("pattern dataset generation (spec §5.3/§6.3: ~5,000 patterns)", () => {
  const patterns = generatePatterns();

  it("generates at least 5,000 patterns", () => {
    expect(patterns.length).toBeGreaterThanOrEqual(5000);
  });

  it("is deterministic across runs", () => {
    expect(generatePatterns()).toEqual(patterns);
  });

  it("has unique ids and stable ordering", () => {
    const ids = new Set(patterns.map((p) => p.id));
    expect(ids.size).toBe(patterns.length);
    expect(patterns[0]?.id).toBe("pattern_00001");
    expect(patterns[4999]?.id).toBe("pattern_05000");
  });

  it("covers every deficiency flag category", () => {
    const flags = [...new Set(patterns.flatMap((p) => p.fixes_flags))];
    expect(flags).toEqual(
      expect.arrayContaining([
        "missing_role",
        "missing_output_format",
        "vague_context",
        "low_specificity",
        "no_examples",
      ]),
    );
    const categories = [...new Set(patterns.map((p) => p.category))];
    expect(categories).toEqual(
      expect.arrayContaining([
        "add_role",
        "add_output_format",
        "add_context",
        "improve_specificity",
        "add_examples",
        "role_and_format",
        "role_and_context",
        "format_and_context",
        "full_fix",
      ]),
    );
  });

  it("produces natural, placeholder-free preview text", () => {
    const previews = patterns.map((p) => p.preview);
    for (const preview of previews) {
      expect(preview.length).toBeGreaterThan(8);
      expect(preview).not.toMatch(/[{}[\]]/);
      expect(preview.trim()).not.toBe("");
    }
  });

  it("reflects the curated vocabulary", () => {
    expect(ROLES.length).toBeGreaterThan(50);
    expect(FORMATS.length).toBeGreaterThan(25);
    expect(CONTEXTS.length).toBeGreaterThan(25);
    expect(TOPICS.length).toBeGreaterThan(35);
    expect(EXAMPLES.length).toBeGreaterThan(15);
    const previewText = patterns.map((p) => p.preview).join(" ");
    expect(previewText).toContain("Act as");
    expect(previewText).toContain("bulleted list");
  });
});
