import { describe, expect, it } from "vitest";
import { vectorizeDimensions, vectorizeNamespace } from "../src/index";

describe("vectorize package scaffold", () => {
  it("exposes namespace and dimensions", () => {
    expect(vectorizeNamespace).toBe("prompt-patterns");
    expect(vectorizeDimensions).toBe(1536);
  });
});
