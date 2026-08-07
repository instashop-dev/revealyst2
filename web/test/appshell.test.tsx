// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/AppShell.js";
import type { Team } from "../src/api/types.js";

const mockTeams = vi.hoisted(() => ({
  teams: [] as Team[],
}));

vi.mock("../src/auth/session.js", () => ({
  useAuth: () => ({
    user: { id: "1", email: "jamie@example.com", plan: "free" },
    logout: vi.fn(),
  }),
}));

vi.mock("../src/teams.js", () => ({
  useTeams: () => ({
    teams: mockTeams.teams,
    loading: false,
    refresh: vi.fn(),
  }),
}));

function setTeams(teams: Team[]) {
  mockTeams.teams.length = 0;
  mockTeams.teams.push(...teams);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("app shell", () => {
  beforeEach(() => setTeams([]));

  it("shows the Team nav to managers", () => {
    setTeams([{ id: "t1", name: "Acme", role: "manager", anonymize_identities: true }]);
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

  it("hides the Team nav from members but keeps Library visible", () => {
    setTeams([{ id: "t1", name: "Acme", role: "member", anonymize_identities: true }]);
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    for (const label of ["Progress", "History", "Achievements", "Library", "Settings"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText("Team")).toBeNull();
  });
});
