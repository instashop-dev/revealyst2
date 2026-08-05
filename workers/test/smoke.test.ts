import { describe, expect, it } from "vitest";
import { apiName } from "../src/index";

describe("workers package scaffold", () => {
  it("exposes the package name", () => {
    expect(apiName).toBe("revealyst-workers");
  });
});
