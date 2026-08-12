// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProgressPage } from "../src/pages/ProgressPage.js";
import type { StatsResponse } from "../src/api/types.js";

vi.mock("../src/auth/session.js", () => ({
  useAuth: () => ({ session: { token: "tok" }, user: { email: "j@acme.com" } }),
}));

/** Events exist but every radar dimension is zero (empty breakdowns). */
const statsWithData: StatsResponse = {
  period: "7d",
  prompts_count: 12,
  green_count: 0,
  avg_score: 31,
  accepted_count: 0,
  clarity_count: 0,
  format_count: 0,
  shared_count: 0,
  streak_days: 0,
  trend: [{ day: "2026-08-01", avg_score: 30 }],
  radar: {},
  improvement: {
    pqs_delta_4w: null,
    current_avg: null,
    baseline_avg: null,
    reprompt_rate: null,
    reprompt_rate_prev: null,
    active_weeks: 0,
  },
};

const statsEmpty: StatsResponse = { ...statsWithData, prompts_count: 0 };

let mockStats: StatsResponse = statsWithData;
vi.mock("../src/api/client.js", () => ({
  api: {
    stats: vi.fn(async () => mockStats),
  },
}));

beforeEach(() => {
  mockStats = statsWithData;
});

afterEach(cleanup);

describe("ProgressPage", () => {
  it("shows stats, not the onboarding checklist, once prompts exist (even with zero radar)", async () => {
    mockStats = statsWithData;
    render(
      <MemoryRouter>
        <ProgressPage />
      </MemoryRouter>,
    );
    // Real data → the checklist must not replace the stats.
    expect(await screen.findByText("Score trend (7 days)")).toBeTruthy();
    expect(screen.queryByText("Get started")).toBeNull();
    expect(screen.getByText(/12 prompts coached/)).toBeTruthy();
    // Zero radar dimensions → the radar section is simply omitted.
    expect(screen.queryByText("Strengths & weaknesses")).toBeNull();
  });

  it("shows the onboarding checklist when no prompts exist yet", async () => {
    mockStats = statsEmpty;
    render(
      <MemoryRouter>
        <ProgressPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Get started")).toBeTruthy();
    expect(screen.queryByText("Score trend (7 days)")).toBeNull();
  });
});
