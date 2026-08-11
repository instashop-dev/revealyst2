// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AchievementsPage, statsForBadge, type Badge } from "../src/pages/AchievementsPage.js";
import type { StatsResponse } from "../src/api/types.js";

vi.mock("../src/auth/session.js", () => ({
  useAuth: () => ({ session: { token: "tok" } }),
}));
vi.mock("../src/api/client.js", () => ({
  api: {
    stats: vi.fn(async (_token: string, period: string) =>
      period === "7d"
        ? { green_count: 2, clarity_count: 0, format_count: 0, shared_count: 0, streak_days: 0 }
        : {
            green_count: 4,
            clarity_count: 3,
            format_count: 10,
            shared_count: 1,
            streak_days: 3,
          },
    ),
  },
}));

const monthStats: StatsResponse = {
  period: "30d",
  prompts_count: 20,
  green_count: 4,
  avg_score: 62,
  accepted_count: 3,
  clarity_count: 3,
  format_count: 10,
  shared_count: 2,
  streak_days: 3,
  trend: [],
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

afterEach(cleanup);

describe("AchievementsPage", () => {
  it("shows progress toward locked badges instead of a blank lock", async () => {
    render(<AchievementsPage />);
    // 3/10 for Clarity Pro (clarity_count=3).
    expect(await screen.findByText("3 / 10")).toBeTruthy();
    // 10/25 for Format Master (format_count=10).
    expect(await screen.findByText("10 / 25")).toBeTruthy();
    // 2/5 for First Week Challenge (7d green_count=2 — week stats).
    expect(await screen.findByText("2 / 5")).toBeTruthy();
    // 1/5 for Team Player (month shared_count=1).
    expect(await screen.findByText("1 / 5")).toBeTruthy();
  });

  it("marks earned badges with no progress bar", async () => {
    render(<AchievementsPage />);
    // green_count=4 → First Green is earned (needs ≥1).
    expect(await screen.findByText("Earned ✓")).toBeTruthy();
  });
});

describe("statsForBadge", () => {
  it("uses the 7-day stats for the first-week challenge, 30d otherwise", () => {
    const week: StatsResponse = { ...monthStats, green_count: 2 };
    const badge: Badge = {
      id: "first-week",
      name: "First Week Challenge",
      desc: "desc",
      check: (s: StatsResponse) => s.green_count >= 5,
      progress: (s: StatsResponse) => ({ current: s.green_count, target: 5 }),
    };
    expect(statsForBadge(badge, monthStats, week)?.green_count).toBe(2);
    const other: Badge = { ...badge, id: "clarity-pro" };
    expect(statsForBadge(other, monthStats, week)?.green_count).toBe(4);
  });
});
