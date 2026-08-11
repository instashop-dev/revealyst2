import { describe, expect, it } from "vitest";
import { STARTER_PROMPTS } from "../src/lib/templates.js";

describe("starter prompts (sidebar empty-state value)", () => {
  it("provides one-click starters for common non-technical tasks", () => {
    expect(STARTER_PROMPTS.length).toBeGreaterThanOrEqual(4);
    const labels = STARTER_PROMPTS.map((t) => t.label);
    expect(labels).toContain("Write an email");
    expect(labels).toContain("Summarize");
    expect(labels).toContain("Brainstorm");
  });

  it("has unique ids and non-empty prompts", () => {
    const ids = new Set(STARTER_PROMPTS.map((t) => t.id));
    expect(ids.size).toBe(STARTER_PROMPTS.length);
    for (const t of STARTER_PROMPTS) {
      expect(t.prompt.trim().length).toBeGreaterThan(20);
    }
  });

  it("contains no placeholders or invented business facts", () => {
    // Same hygiene standard as suggestion previews: a starter that inserts
    // "[topic]" or "our summer launch" would be fake advice.
    for (const t of STARTER_PROMPTS) {
      expect(t.prompt).not.toMatch(/\[|\]|\{|\}|\.\.\.|…/);
      expect(t.prompt).not.toMatch(
        /\b(our|my|we) (summer|spring|fall|winter|company|product|blog)\b/i,
      );
    }
  });
});
