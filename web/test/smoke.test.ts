import { describe, expect, it } from "vitest";
import { API_BASE } from "../src/api/client.js";

describe("web package", () => {
  it("targets the hosted Workers API by default", () => {
    expect(API_BASE).toContain("https://");
    expect(API_BASE).toContain("workers.dev");
  });
});
