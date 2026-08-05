import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE, api } from "../src/api/client.js";

afterEach(() => vi.unstubAllGlobals());

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("web API client", () => {
  it("requests a magic link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ message: "link sent" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.requestMagicLink("a@b.com");
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/auth/magic`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("a@b.com") }),
    );
  });

  it("verifies a magic token into a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(json({ token: "t", user: { id: "1", email: "a@b.com", plan: "free" } })),
    );
    const session = await api.verifyMagicToken("tok");
    expect(session.user.email).toBe("a@b.com");
  });

  it("loads the team dashboard with auth header and period", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          team_id: "t",
          period: "7d",
          avg_score: 66,
          common_weaknesses: [],
          top_prompts: [],
          volume_by_platform: [],
          volume_by_day: [],
          trends_by_user: [],
        }),
      ),
    );
    await api.teamDashboard("sess", "team-1", "7d");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `${API_BASE}/api/team/dashboard?team_id=team-1&period=7d`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
  });

  it("surfaces API error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ message: "Only managers can view the dashboard" }, 403)),
    );
    await expect(api.teamDashboard("sess", "t")).rejects.toThrow(
      "Only managers can view the dashboard",
    );
  });
});
