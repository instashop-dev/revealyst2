import { describe, expect, it } from "vitest";
import {
  describeDeficiency,
  normalizeSuggestions,
  selectStaticPatterns,
} from "../src/suggestions.js";

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
    const picked = selectStaticPatterns(["missing_output_format"]);
    expect(picked[0]?.category).toBe("add_output_format");
    expect(picked[0]?.priority).toBe(1);
  });

  it("returns no fabricated role patterns for a missing role", () => {
    // The engine never knows the task, so role coaching is advisory
    // (ROLE_SUGGESTION at the getSuggestions level), never a guessed role.
    expect(selectStaticPatterns(["missing_role"])).toHaveLength(0);
  });

  it("never inserts fabricated business facts in static context previews", () => {
    const picked = selectStaticPatterns(["vague_context"]);
    for (const p of picked) {
      expect(p.preview).not.toMatch(/\b(we|our|i) (are|have|sell|launched|want|need)\b/i);
      expect(p.preview).not.toMatch(/\[|\]|\.\.\.|…/);
    }
  });
});

describe("normalizeSuggestions", () => {
  it("replaces fabricated role suggestions with the advisory suggestion", () => {
    const out = normalizeSuggestions([
      {
        id: "add_role",
        type: "add_role",
        text: "Define a role.",
        preview: "Act as an AI prompt engineer. ",
        action: "prepend",
      },
      {
        id: "add_role",
        type: "add_role",
        text: "Define a role.",
        preview: "Act as a QA specialist. ",
        action: "prepend",
      },
    ]);
    // Never a fabricated role: exactly one advisory suggestion, no preview.
    expect(out).toHaveLength(1);
    expect(out[0]?.advisory).toBe(true);
    expect(out[0]?.preview).toBe("");
    expect(out[0]?.preview).not.toMatch(/Act as/i);
  });

  it("drops non-role placeholder previews ([role], '...')", () => {
    const out = normalizeSuggestions([
      {
        id: "add_context",
        type: "add_context",
        text: "Add context.",
        preview: " For context: ...",
        action: "append",
      },
      {
        id: "add_output_format",
        type: "add_output_format",
        text: "Add a format.",
        preview: "Respond as a [format]. ",
        action: "prepend",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it("drops previews that assert invented business facts", () => {
    const out = normalizeSuggestions([
      {
        id: "add_context",
        type: "add_context",
        text: "Add context.",
        preview: " Respond as a checklist. For context: our trial conversion is low.",
        action: "append",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it("keeps the advisory role suggestion without a merged format suffix", () => {
    const out = normalizeSuggestions([
      {
        id: "add_role",
        type: "add_role",
        text: "Add a role.",
        preview: "Act as a public speaking coach and respond as an abstract.",
        action: "prepend",
      },
    ]);
    // Never fabricated — the user completes the role themselves.
    expect(out[0]?.advisory).toBe(true);
    expect(out[0]?.preview).toBe("");
    expect(out[0]?.preview).not.toMatch(/Act as|respond as/i);
  });

  it("dedupes near-identical suggestions and caps at 3", () => {
    const dup = {
      id: "add_format",
      type: "add_output_format",
      text: "Specify a format.",
      preview: " Respond as a checklist.",
      action: "append",
    };
    const out = normalizeSuggestions([
      dup,
      { ...dup, id: "add_format_2" },
      { id: "a", type: "x", text: "t1", preview: " p1.", action: "prepend" },
      { id: "b", type: "y", text: "t2", preview: " p2.", action: "prepend" },
      { id: "c", type: "z", text: "t3", preview: " p3.", action: "prepend" },
      { id: "d", type: "w", text: "t4", preview: " p4.", action: "prepend" },
    ]);
    expect(out.map((s) => s.preview)).toEqual([" Respond as a checklist.", " p1.", " p2."]);
  });

  it("keeps clean task-appropriate suggestions", () => {
    const out = normalizeSuggestions([
      {
        id: "add_role",
        type: "add_role",
        text: "Give the AI a defined expert role.",
        preview: "Act as a senior marketing strategist. ",
        action: "prepend",
      },
      {
        id: "add_context",
        type: "add_context",
        text: "Add who it is for.",
        preview:
          " Add 2-3 sentences of background: who this is for, why you need it, and what you already know.",
        action: "append",
      },
    ]);
    expect(out).toHaveLength(2);
  });
});
