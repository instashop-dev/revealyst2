import { describe, expect, it } from "vitest";
import { app } from "../src/index.js";

describe("workers package", () => {
  it("exposes the Hono app", () => {
    expect(typeof app.fetch).toBe("function");
    expect(app.routes.length).toBeGreaterThan(0);
  });
});
