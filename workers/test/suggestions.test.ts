import { describe, expect, it } from "vitest";
import { describeDeficiency, selectStaticPatterns } from "../src/suggestions.js";

describe("describeDeficiency", () => {
  it("describes a single deficiency (spec §7: embedding query text)", () => {
    expect(describeDeficiency(["missing_role"])).toBe(
      "Fix a prompt that no expert role or persona is defined for the AI.",
    );
  });

  it("joins multiple deficiencies cleanly", () => {
    expect(describeDeficiency(["missing_role", "no_examples"])).toBe(
      "Fix a prompt that no expert role or persona is defined for the AI and no example inputs or outputs are provided.",
    );
  });

  it("falls back for unknown flags", () => {
    expect(describeDeficiency(["mystery_flag"])).toBe("Fix a prompt that mystery flag.");
  });

  it("returns a generic query for empty flags", () => {
    expect(describeDeficiency([])).toBe("Improve the prompt quality.");
  });
});

describe("selectStaticPatterns", () => {
  it("spreads coverage across distinct deficiencies, capped at 3", () => {
    const flags = ["missing_role", "missing_output_format", "no_examples", "vague_context"];
    const picked = selectStaticPatterns(flags);
    expect(picked.length).toBeLessThanOrEqual(3);
    const categories = new Set(picked.map((p) => p.category));
    // distinct categories preferred (role + format + examples/context)
    expect(categories.size).toBe(picked.length);
  });

  it("returns nothing when no pattern matches", () => {
    expect(selectStaticPatterns(["unknown_flag"])).toHaveLength(0);
  });

  it("orders by match count then priority", () => {
    const picked = selectStaticPatterns(["missing_role"]);
    expect(picked[0]?.category).toBe("add_role");
    expect(picked[0]?.priority).toBe(1);
  });
});
