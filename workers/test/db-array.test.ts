import { describe, expect, it } from "vitest";
import { pgArrayLiteral } from "../src/db.js";

describe("pgArrayLiteral", () => {
  it("wraps a plain list in braces", () => {
    expect(pgArrayLiteral(["a", "b"])).toBe("{a,b}");
  });

  it("quotes elements with commas or spaces (tags like 'email templates')", () => {
    expect(pgArrayLiteral(["email templates", "sales"])).toBe('{"email templates",sales}');
    expect(pgArrayLiteral(["a,b", "c"])).toBe('{"a,b",c}');
  });

  it("escapes quotes and backslashes inside elements", () => {
    expect(pgArrayLiteral(['he said "hi"', "a\\b"])).toBe('{"he said \\"hi\\"","a\\\\b"}');
  });

  it("quotes empty and whitespace-only elements", () => {
    expect(pgArrayLiteral([""])).toBe('{""}');
    expect(pgArrayLiteral([" "])).toBe('{" "}');
  });

  it("produces a literal that Postgres parses back", () => {
    // Round-trip property: `{...}` literal with commas/spaces/quotes parses
    // to the same elements (mirrors what the TEXT[] INSERT relies on).
    const literal = pgArrayLiteral(["vague context", 'say "hi"', "a,b"]);
    expect(literal).toBe('{"vague context","say \\"hi\\"","a,b"}');
  });
});
