// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendLocalHistory,
  clearLocalHistory,
  getLocalHistory,
  getSettings,
  rateLocalHistory,
  setSettings,
} from "../src/lib/storage.js";

/** Minimal chrome.storage.local mock (in-memory map). */
function stubChromeStorage() {
  const map = new Map<string, unknown>();
  const chromeMock = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          const value = map.get(key);
          return value === undefined ? {} : { [key]: value };
        }),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) map.set(k, v);
        }),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  return { map };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings storage", () => {
  it("persists the API token and team id (spec §5.1/§5.6)", async () => {
    stubChromeStorage();
    await setSettings({ apiToken: "tok-1", teamId: "team-1" });
    const settings = await getSettings();
    expect(settings.apiToken).toBe("tok-1");
    expect(settings.teamId).toBe("team-1");
    expect(settings.cloudSync).toBe(false); // default off — privacy-first
  });
});

describe("local prompt history (spec §5.1/§5.4 — device only)", () => {
  it("appends entries, de-dupes consecutive identical prompts, and records ratings", async () => {
    stubChromeStorage();
    await appendLocalHistory({
      prompt: "Write a report",
      score: 45,
      flags: ["missing_role"],
      platform: "chatgpt",
      rating: null,
      createdAt: "2026-08-07T10:00:00.000Z",
    });
    // Same prompt scored again (typing refresh) → merged, not duplicated.
    await appendLocalHistory({
      prompt: "Write a report",
      score: 50,
      flags: ["missing_role"],
      platform: "chatgpt",
      rating: null,
      createdAt: "2026-08-07T10:00:05.000Z",
    });
    await appendLocalHistory({
      prompt: "Draft an email",
      score: 80,
      flags: [],
      platform: "claude",
      rating: null,
      createdAt: "2026-08-07T10:01:00.000Z",
    });

    let history = await getLocalHistory();
    expect(history).toHaveLength(2);
    expect(history[0]?.prompt).toBe("Draft an email");
    expect(history[1]?.score).toBe(50); // updated in place, original timestamp kept

    await rateLocalHistory("Write a report", "chatgpt", 1);
    history = await getLocalHistory();
    expect(history[1]?.rating).toBe(1);

    await clearLocalHistory();
    expect(await getLocalHistory()).toEqual([]);
  });
});
