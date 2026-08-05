// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/AppShell.js";

vi.mock("../src/auth/session.js", () => ({
  useAuth: () => ({
    user: { id: "1", email: "jamie@example.com", plan: "free" },
    logout: vi.fn(),
  }),
}));

afterEach(() => vi.restoreAllMocks());

describe("app shell", () => {
  it("renders navigation and the signed-in email", () => {
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    for (const label of ["Progress", "History", "Achievements", "Library", "Team", "Settings"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("jamie@example.com")).toBeTruthy();
  });
});
