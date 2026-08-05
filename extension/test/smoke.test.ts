import { describe, expect, it } from "vitest";
import { extensionName } from "../src/index";

describe("extension package scaffold", () => {
  it("exposes the package name", () => {
    expect(extensionName).toBe("revealyst-extension");
  });
});
