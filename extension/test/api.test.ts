import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSuggestions,
  fetchTeams,
  logEvent,
  postFeedback,
  saveToLibrary,
} from "../src/background/api.js";

const BASE = "https://revealyst-workers.thapi.workers.dev";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("background API client", () => {
  it("requests suggestions with flags and returns the parsed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ suggestions: [{ id: "add_role" }], source: "vectorize+llm" }),
        ),
    );
    const res = await fetchSuggestions(BASE, ["missing_role"], undefined, "abc");
    expect(res.source).toBe("vectorize+llm");
    expect(res.suggestions[0]?.id).toBe("add_role");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `${BASE}/api/suggestion`,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("missing_role"),
      }),
    );
    // Spec §6.4: the suggestion request carries the prompt hash.
    expect(JSON.stringify(vi.mocked(fetch).mock.calls[0]![1]!.body)).toContain("abc");
  });

  it("retries a transient network failure once (spec §7)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ suggestions: [{ id: "add_role" }], source: "static" }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchSuggestions(BASE, ["missing_role"]);
    expect(res.source).toBe("static");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on suggestion failure so callers can fall back (spec §7)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 500)));
    await expect(fetchSuggestions(BASE, [])).rejects.toThrow();
  });

  it("logs anonymised events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true })));
    await expect(
      logEvent(BASE, {
        prompt_hash: "abc123",
        score: 72,
        flags: [],
        breakdown: {
          specificity: 80,
          context: 60,
          role_clarity: 90,
          output_format: 80,
          examples_included: 40,
        },
        llm_platform: "chatgpt",
      }),
    ).resolves.toBeUndefined();
  });

  it("attributes events to the signed-in user via the session token (spec §5.4)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true })));
    await logEvent(
      BASE,
      {
        prompt_hash: "abc123",
        score: 72,
        flags: [],
        breakdown: {
          specificity: 80,
          context: 60,
          role_clarity: 90,
          output_format: 80,
          examples_included: 40,
        },
        llm_platform: "chatgpt",
        team_id: "team-1",
        user_anon_id: "anon-1",
        rating: 1,
      },
      "token-abc",
    );
    const [, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
    expect(JSON.parse(init.body as string)).toMatchObject({
      team_id: "team-1",
      user_anon_id: "anon-1",
      rating: 1,
    });
  });

  it("throws a status-carrying error on a 403 team attribution so callers can retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403)));
    try {
      await logEvent(BASE, {
        prompt_hash: "abc123",
        score: 50,
        flags: [],
        breakdown: {
          specificity: 80,
          context: 60,
          role_clarity: 90,
          output_format: 80,
          examples_included: 40,
        },
        llm_platform: "chatgpt",
        team_id: "team-1",
      });
      expect.unreachable("logEvent should throw on 403");
    } catch (err) {
      expect((err as { status: number }).status).toBe(403);
    }
  });

  it("sends the session token with save-to-library (spec §5.6)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "p-1" }, 201)));
    const res = await saveToLibrary(
      BASE,
      { team_id: "team-1", prompt_text: "x", score: 50 },
      "token-abc",
    );
    expect(res.id).toBe("p-1");
    const [, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
    expect(JSON.parse(init.body as string)).toMatchObject({ team_id: "team-1" });
  });

  it("posts suggestion feedback (spec §5.6 suggestions_feedback)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true })));
    await postFeedback(BASE, "token-abc", "add_role", true);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/feedback`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
    expect(JSON.parse(init.body as string)).toEqual({
      suggestion_id: "add_role",
      was_accepted: true,
    });
  });

  it("loads the user's teams for the settings panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ teams: [{ id: "t1", name: "Acme", role: "manager" }] })),
    );
    const teams = await fetchTeams(BASE, "token-abc");
    expect(teams).toHaveLength(1);
    expect(teams[0]?.name).toBe("Acme");
  });

  it("surfaces the library error message for duplicates", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: "duplicate", message: "Already saved" }, 409)),
    );
    await expect(
      saveToLibrary(BASE, { team_id: "t", prompt_text: "x", score: 50 }),
    ).rejects.toThrow("Already saved");
  });
});
