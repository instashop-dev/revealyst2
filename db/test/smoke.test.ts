import { describe, expect, it } from "vitest";
import { migrationsDir } from "../src/index";

describe("db package scaffold", () => {
  it("points at the migrations directory", () => {
    expect(migrationsDir).toBe("migrations");
  });
});
