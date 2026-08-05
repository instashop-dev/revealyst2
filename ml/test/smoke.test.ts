import { describe, expect, it } from "vitest";
import { modelArtifactDir } from "../src/index";

describe("ml package scaffold", () => {
  it("exposes the model artifact directory", () => {
    expect(modelArtifactDir).toBe("models");
  });
});
