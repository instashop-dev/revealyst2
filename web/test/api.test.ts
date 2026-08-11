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
        .mockResolvedValue(
          json({ token: "t", user: { id: "1", email: "a@b.com", plan: "free", is_admin: false } }),
        ),
    );
    const session = await api.verifyMagicToken("tok");
    expect(session.user.email).toBe("a@b.com");
  });

  it("lists admin users with the auth header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ users: [{ id: "u1", email: "a@b.com" }], total: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await api.adminUsers("sess");
    expect(res.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/admin/users`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
  });

  it("impersonates a user via the admin endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({ token: "t", user: { id: "u2", email: "x@y.com", plan: "free", is_admin: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const session = await api.adminImpersonate("sess", "u2");
    expect(session.user.email).toBe("x@y.com");
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/admin/impersonate`,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("u2"),
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
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
          score_by_day: [],
          trends_by_user: [],
          identifiable: false,
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

  it("lists my teams with the auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ teams: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await api.myTeams("sess");
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/teams`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
  });

  it("fetches history with period and min score", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ events: [], note: "n" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.history("sess", "30d", undefined, 70);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/history?period=30d&min_score=70`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
  });

  it("fetches personal stats for a period", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ period: "7d", prompts_count: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.stats("sess", "7d");
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/stats?period=7d`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
  });

  it("lists library prompts with sort, tag and min score", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ prompts: [], total: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.libraryList("sess", "team-1", {
      sort: "highest_score",
      tag: "email",
      minScore: 70,
      page: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/library?team_id=team-1&tag=email&min_score=70&sort=highest_score&page=2`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
  });

  it("patches a library card via PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: "p1", is_standard: true }));
    vi.stubGlobal("fetch", fetchMock);
    await api.libraryPatch("sess", "p1", { is_standard: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/library/p1`,
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining("is_standard"),
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
  });

  it("saves a prompt to the library with a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: "p1" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.librarySave("sess", { team_id: "team-1", prompt_text: "x", title: "T", tags: ["a"] });
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/library`,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("team-1"),
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
  });

  it("surfaces a duplicate save (409) with its status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: "Already saved" }, 409)));
    await expect(api.librarySave("sess", { team_id: "t", prompt_text: "x" })).rejects.toMatchObject(
      { status: 409, message: "Already saved" },
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

  it("deletes the account with a DELETE request and the auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await api.deleteAccount("sess");
    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/api/account`,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ Authorization: "Bearer sess" }),
      }),
    );
  });
});
