import { describe, expect, it } from "vitest";
import { appName } from "../src/index";

describe("web package scaffold", () => {
  it("exposes the package name", () => {
    expect(appName).toBe("revealyst-web");
  });
});
