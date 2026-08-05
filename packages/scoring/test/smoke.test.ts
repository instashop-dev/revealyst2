import { describe, expect, it } from "vitest";
import { scoringEngineName } from "../src/index";

describe("scoring package scaffold", () => {
  it("exposes the package name", () => {
    expect(scoringEngineName).toBe("revealyst-scoring");
  });
});
