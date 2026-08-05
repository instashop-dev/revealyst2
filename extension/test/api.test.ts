import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSuggestions, logEvent, saveToLibrary } from "../src/background/api.js";

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
    const res = await fetchSuggestions(BASE, ["missing_role"]);
    expect(res.source).toBe("vectorize+llm");
    expect(res.suggestions[0]?.id).toBe("add_role");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `${BASE}/api/suggestion`,
      expect.objectContaining({ method: "POST", body: expect.stringContaining("missing_role") }),
    );
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
