/**
 * Live end-to-end tests against the REAL ChatGPT web app.
 *
 * Works signed-in or signed-out: chatgpt.com's composer is testable directly
 * (logged-out "try it" prompts are answered by the model too). A signed-in
 * profile (scripts/live-login.mjs) only adds chat-list navigation coverage.
 *
 * Run:
 *   REVEALYST_LIVE=1 npm run e2e:live
 *   (Windows cmd: set REVEALYST_LIVE=1 && npm run e2e:live)
 *
 * They are skipped unless REVEALYST_LIVE=1 so CI and `npm run e2e` stay green
 * against the local mock pages only.
 */
import { test as base, expect, chromium } from "@playwright/test";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const LIVE = process.env.REVEALYST_LIVE === "1";
const HEADLESS = process.env.REVEALYST_LIVE_HEADLESS === "1";
const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const DEFAULT_API_BASE = "https://revealyst-workers.thapi.workers.dev";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** ProseMirror renders a trailing/leading space as a non-breaking space in
 *  textContent; normalise for exact comparisons. */
const norm = (s: string) => s.replace(/\u00a0/g, " ");

const HOST = "#revealyst-sidebar-host";
const SCORE = "span.font-mono.text-4xl";

/** All network requests observed during a test, for privacy/sync assertions. */
interface NetFixture {
  requests: Request[];
}

const test = base.extend<{ context: BrowserContext; net: NetFixture }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the fixtures arg to be an object destructuring pattern
  context: async ({}, use) => {
    // Fresh profile per test. chatgpt.com restores composer drafts and the
    // extension keeps storage in the shared profile dir, so a shared dir leaks
    // state across tests (e.g. the previous test's draft gets scored and the
    // cloud prompt_hash no longer matches what was typed). Set
    // REVEALYST_LIVE_PROFILE to use a fixed profile instead (e.g. a signed-in
    // session produced by scripts/live-login.mjs).
    const fixedProfile = process.env.REVEALYST_LIVE_PROFILE;
    const profileDir =
      fixedProfile ??
      path.join(os.tmpdir(), `revealyst-live-profile-${Date.now()}-${Math.round(Math.random() * 1e6)}`);
    // Playwright's bundled Chromium: official Chrome (137+) no longer accepts
    // --load-extension, so extension e2e must use the bundled build.
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: "chromium",
      // Headed by default: ChatGPT's bot detection blocks headless browsers.
      headless: HEADLESS,
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "allow",
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    // Fail fast with a clear message if the extension did not load.
    const sw = await (async () => {
      for (let i = 0; i < 15; i++) {
        const sws = context.serviceWorkers();
        if (sws.length) return sws[0];
        await new Promise((r) => setTimeout(r, 1000));
      }
      return undefined;
    })();
    if (!sw)
      throw new Error(
        "extension service worker did not load — run npm run build -w extension first",
      );
    await use(context);
    await context.close();
    // Auto-generated temp profiles are per-test; remove them (a fixed
    // REVEALYST_LIVE_PROFILE dir is the user's, leave it alone).
    if (!fixedProfile) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  net: async ({ context }, use) => {
    const requests: Request[] = [];
    context.on("request", (r) => requests.push(r));
    await use({ requests });
  },
});

// ---------- helpers ---------------------------------------------------------

async function getSW(context: BrowserContext) {
  for (let i = 0; i < 15; i++) {
    const sws = context.serviceWorkers();
    if (sws.length) return sws[0]!;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("extension service worker not found — is the extension built and loaded?");
}

/** Read the extension's chrome.storage.local from the service worker. */
async function extStorage(context: BrowserContext): Promise<Record<string, unknown>> {
  const sw = await getSW(context);
  return sw.evaluate(() => chrome.storage.local.get(null));
}

/** Reset extension state to clean defaults (preserving the anon id). */
async function resetExtension(context: BrowserContext, page: Page) {
  const sw = await getSW(context);
  await sw.evaluate(async () => {
    const cur = ((await chrome.storage.local.get("revealyst:settings"))["revealyst:settings"] ??
      {}) as Record<string, unknown>;
    await chrome.storage.local.set({
      "revealyst:settings": {
        paused: false,
        cloudSync: false,
        apiBase: "https://revealyst-workers.thapi.workers.dev",
        platformSelectors: {},
        apiToken: "",
        accountEmail: "",
        teamId: "",
        anonId: cur.anonId ?? "",
      },
      "revealyst:onboarding": { completed: true },
      "revealyst:history": [],
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
}

/** Ensure onboarding is dismissed (whatever the profile state). Retries the
 *  "Got it" click: the sidebar re-renders as the onboarding sample animates,
 *  which can detach the button mid-click on a fresh profile. */
async function dismissOnboarding(page: Page): Promise<void> {
  const host = page.locator(HOST);
  await expect(host).toBeAttached({ timeout: 30_000 });
  for (let i = 0; i < 8; i++) {
    const done = host.getByText("Got it — start coaching");
    if ((await done.count()) === 0) return; // already onboarded
    await done.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  await expect(host).toContainText("Prompt Quality Score", { timeout: 15_000 });
}

/** Ensure onboarding is dismissed (whatever the profile state). */
async function ensureOnboarded(page: Page) {
  await dismissOnboarding(page);
}

/** Resolve the visible ChatGPT composer (the id may sit on either the visible
 *  contenteditable div or — after a11y fallback changes — a hidden textarea).
 *  chatgpt.com sometimes gates signed-out sessions behind a "Log in or sign
 *  up" interstitial; "Try it first" opens the composer without logging in. */
async function getComposer(page: Page) {
  const tryIt = page.locator("a:has-text('Try it first')");
  if ((await tryIt.count()) > 0 && (await tryIt.first().isVisible().catch(() => false))) {
    await tryIt.first().click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  const byId = page.locator("#prompt-textarea");
  if (
    (await byId.count()) > 0 &&
    (await byId
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    return byId.first();
  }
  return page.locator("div[contenteditable='true']:visible, textarea:visible").first();
}

/** Type into the ChatGPT composer (works for textarea and contenteditable). */
async function typePrompt(page: Page, text: string) {
  const composer = await getComposer(page);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.click();
  // ChatGPT restores the last composer draft (e.g. when REVEALYST_LIVE_PROFILE
  // reuses a signed-in profile across tests). Clear it with real keystrokes so
  // the editor's model stays consistent with its DOM before filling the text.
  await composer.press("ControlOrMeta+a");
  await composer.press("Backspace");
  try {
    await composer.fill(text);
  } catch {
    await composer.pressSequentially(text, { delay: 5 });
  }
  // chatgpt.com A/B-tests two composer layouts (a ProseMirror editor and a
  // hidden a11y textarea mirror). The content script scores whichever one it
  // detects, so mirror the text into every candidate that differs — otherwise
  // a stale draft can be scored and the cloud prompt_hash won't match what was
  // typed. When fill() already propagated into the editor this is a no-op.
  await page.evaluate((t) => {
    for (const el of document.querySelectorAll("textarea, div[contenteditable='true']")) {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.value = t;
      else if ((el as HTMLElement).isContentEditable && el.textContent !== t) el.textContent = t;
    }
    document
      .querySelectorAll("textarea, div[contenteditable='true']")
      .forEach((el) => el.dispatchEvent(new Event("input", { bubbles: true })));
  }, text);
}

/** Trigger a blur on the composer so the extension flushes the score. */
async function blurComposer(page: Page) {
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    el?.blur();
  });
}

/** Wait until the sidebar shows a numeric score; return it. */
async function waitForScore(page: Page, timeout = 25_000): Promise<number> {
  const score = page.locator(HOST).locator(SCORE);
  await expect(score).not.toHaveText("—", { timeout });
  await expect(score).not.toHaveText("waiting for input", { timeout: 5000 });
  return parseInt(await score.innerText(), 10);
}

function historyOf(storage: Record<string, unknown>): Array<Record<string, unknown>> {
  return (storage["revealyst:history"] as Array<Record<string, unknown>>) ?? [];
}

function settingsOf(storage: Record<string, unknown>): Record<string, unknown> {
  return (storage["revealyst:settings"] as Record<string, unknown>) ?? {};
}

const NON_LLM_DOMAINS = (r: Request) => {
  try {
    const host = new URL(r.url()).hostname;
    return (
      !/(chatgpt|openai)\.com$/.test(host) &&
      !host.endsWith(".openai.com") &&
      !host.endsWith(".chatgpt.com")
    );
  } catch {
    return true;
  }
};

// ---------- tests -----------------------------------------------------------

const describe = LIVE ? test.describe : test.describe.skip;
describe("Revealyst sidebar on real chatgpt.com", () => {
  test.setTimeout(240_000);

  test("extension loads, sidebar injects, onboarding completes", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    const host = page.locator(HOST);
    await expect(host).toBeAttached({ timeout: 30_000 });

    // Onboarding shows on a fresh profile; if it is already done, skip.
    await dismissOnboarding(page);
    await expect(host).toContainText("Prompt Quality Score", { timeout: 15_000 });
    await expect(host).toContainText("Team sync: off");

    // Content script must have found the real ChatGPT composer.
    await expect(await getComposer(page)).toBeVisible({ timeout: 30_000 });
    expect(await page.locator(HOST).getByText("Revealyst can't find the input field").count()).toBe(
      0,
    );
  });

  test("scores a normal prompt; metadata correct; repeats are deduped", async ({
    context,
    page,
  }) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await resetExtension(context, page);
    await ensureOnboarded(page);

    const prompt = `Write a concise status update for my team about the Revealyst integration. `;
    await typePrompt(page, prompt);
    await blurComposer(page);
    const score = await waitForScore(page);

    await page.waitForTimeout(1500); // let the history write settle
    let storage = await extStorage(context);
    let history = historyOf(storage);
    expect(history.length).toBeGreaterThanOrEqual(1);
    const entry = history[0]!;
    expect(norm(entry.prompt as string)).toBe(prompt);
    expect(entry.platform).toBe("chatgpt");
    expect(typeof entry.score).toBe("number");
    expect(Array.isArray(entry.flags)).toBe(true);
    expect(entry.rating).toBeNull();
    expect(new Date(entry.createdAt as string).getTime()).not.toBeNaN();
    expect(entry.score).toBe(score);

    // Same prompt again → still exactly one history entry for it (dedup).
    await typePrompt(page, prompt);
    await blurComposer(page);
    await page.waitForTimeout(1500);
    storage = await extStorage(context);
    history = historyOf(storage);
    expect(history.filter((h) => norm(h.prompt as string) === prompt).length).toBe(1);
  });

  test("debounces rapid typing — only the final prompt is scored", async ({ context, page }) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await resetExtension(context, page);
    await ensureOnboarded(page);

    const a = "first rapid prompt";
    const b = "second rapid prompt";
    const c = "third rapid prompt";
    await typePrompt(page, a);
    await typePrompt(page, b);
    await typePrompt(page, c);
    // No blur between — the 2s debounce should collapse A and B away.
    const score = await waitForScore(page);
    expect(typeof score).toBe("number");

    await page.waitForTimeout(1500);
    const history = historyOf(await extStorage(context));
    expect(history[0]!.prompt).toBe(c);
    expect(history.filter((h) => [a, b, c].includes(h.prompt as string)).length).toBe(1);

    // A distinct prompt with a blur produces a second, separate entry.
    const d = "fourth distinct prompt after a blur";
    await typePrompt(page, d);
    await blurComposer(page);
    await page.waitForTimeout(2500);
    const history2 = historyOf(await extStorage(context));
    expect(history2[0]!.prompt).toBe(d);
    expect(history2.filter((h) => h.prompt === d).length).toBe(1);
  });

  test("handles a very long prompt (12k chars) with truncation and no errors", async ({
    context,
    page,
  }) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await resetExtension(context, page);
    await ensureOnboarded(page);

    const long = "long context paragraph. ".repeat(600).slice(0, 12_000);
    expect(long.length).toBe(12_000);

    const errors: string[] = [];
    const onPageError = (e: Error) => errors.push(`pageerror: ${e.message}`);
    page.on("pageerror", onPageError);

    await typePrompt(page, long);
    await blurComposer(page);
    const score = await waitForScore(page, 40_000);
    expect(typeof score).toBe("number");

    await page.waitForTimeout(1500);
    const entry = historyOf(await extStorage(context))[0]!;
    expect((entry.prompt as string).length).toBe(2000); // truncated for local history
    expect(entry.platform).toBe("chatgpt");
    expect(errors.filter((e) => !e.includes("ResizeObserver"))).toEqual([]);
  });

  test("new chat and navigation between chats keep the sidebar alive", async ({
    context,
    page,
  }) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await resetExtension(context, page);
    await ensureOnboarded(page);

    const host = page.locator(HOST);

    // New chat → composer resets, sidebar still present and scoring works.
    const newChat = page
      .locator(
        "a[aria-label='New chat'], button[aria-label='New chat'], [data-testid='new-chat-button']",
      )
      .first();
    if ((await newChat.count()) > 0) {
      await newChat.click();
      await page.waitForTimeout(3000);
    }
    await expect(host).toBeAttached({ timeout: 15_000 });
    await expect(host).toContainText("Prompt Quality Score");

    // Open an existing chat from the sidebar (a real conversation URL /c/...).
    const existing = page.locator("a[href^='/c/']").first();
    if ((await existing.count()) > 0) {
      await existing.click();
      await page.waitForTimeout(4000);
      await expect(host).toBeAttached({ timeout: 15_000 });
      await expect(await getComposer(page)).toBeVisible({ timeout: 30_000 });
      // Type in the existing chat — scoring still works.
      await typePrompt(page, "existing chat prompt probe");
      await blurComposer(page);
      const score = await waitForScore(page);
      expect(typeof score).toBe("number");
    } else {
      // No existing chats yet — create one by sending a message.
      await typePrompt(page, "create a chat for navigation testing");
      await (await getComposer(page)).press("Enter");
      await page.waitForTimeout(6000);
      await expect(host).toBeAttached({ timeout: 15_000 });
    }
  });

  test("page refresh re-injects the sidebar and persists settings + history", async ({
    context,
    page,
  }) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await resetExtension(context, page);
    await ensureOnboarded(page);

    // Turn on cloud sync through the UI, then score a prompt.
    const host = page.locator(HOST);
    await host.getByTitle("Team sync off (privacy-first)").click();
    await expect(host).toContainText("Team sync: on");
    await typePrompt(page, "persistence check prompt");
    await blurComposer(page);
    await waitForScore(page);
    await page.waitForTimeout(1500);

    const before = await extStorage(context);
    expect(settingsOf(before).cloudSync).toBe(true);
    const historyBefore = historyOf(before).length;

    // Hard refresh.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await expect(page.locator(HOST)).toBeAttached({ timeout: 30_000 });
    await expect(page.locator(HOST)).toContainText("Team sync: on", { timeout: 15_000 });

    const after = await extStorage(context);
    expect(settingsOf(after).cloudSync).toBe(true);
    expect(historyOf(after).length).toBe(historyBefore);
  });

  test("unreachable API falls back to static offline tips", async ({ context, page, net }) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await resetExtension(context, page);
    await ensureOnboarded(page);

    const host = page.locator(HOST);
    // Point the API base at an unreachable address via the settings panel.
    await host.getByTitle("Settings — token, team, local history").click();
    const baseInput = host.locator("label", { hasText: "API base URL" }).locator("input");
    await expect(baseInput).toBeVisible();
    await baseInput.fill("http://127.0.0.1:1");
    await host.getByRole("button", { name: "Save settings" }).click();
    await expect(host).toContainText("Prompt Quality Score");

    // Score a prompt → suggestion network call fails → static tips appear.
    await typePrompt(page, "help me write something vague and unstructured");
    await blurComposer(page);
    await waitForScore(page);
    await expect(host.getByText("offline tips")).toBeVisible({ timeout: 30_000 });
    await expect(host.getByText("Act as a senior copywriter")).toBeVisible({ timeout: 10_000 });

    // No request to the dead API base must carry any prompt text.
    const deadBaseCalls = net.requests.filter((r) => r.url().includes("127.0.0.1:1"));
    for (const r of deadBaseCalls) {
      expect(r.postData() ?? "").not.toContain("write something vague");
    }

    // Restore the real API base.
    await resetExtension(context, page);
  });

  test("edge cases: empty/whitespace input, pause/resume, special characters", async ({
    context,
    page,
  }) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await resetExtension(context, page);
    await ensureOnboarded(page);

    const host = page.locator(HOST);
    const errors: string[] = [];
    const dialogs: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => dialogs.push(d.message()));

    // Whitespace-only → no scoring, no history entry.
    await typePrompt(page, "   \n\t  ");
    await blurComposer(page);
    await page.waitForTimeout(3000);
    expect(historyOf(await extStorage(context)).length).toBe(0);
    await expect(host.locator(SCORE)).toHaveText("—");

    // Special characters incl. HTML/script must not execute or crash.
    const nasty = "🤖🎉 <script>alert('xss')</script> & \"quotes\" 'single' <b>bold</b> 🚀";
    await typePrompt(page, nasty);
    await blurComposer(page);
    await waitForScore(page);
    await page.waitForTimeout(1500);
    expect(dialogs).toEqual([]); // no alert executed
    expect(errors.filter((e) => !e.includes("ResizeObserver"))).toEqual([]);
    expect(historyOf(await extStorage(context))[0]!.prompt).toBe(nasty);

    // Pause → typing no longer scores or records.
    await host.getByTitle("Pause scoring").click();
    await expect(host).toContainText("Paused");
    const countBefore = historyOf(await extStorage(context)).length;
    await typePrompt(page, "prompt typed while paused");
    await blurComposer(page);
    await page.waitForTimeout(3000);
    expect(historyOf(await extStorage(context)).length).toBe(countBefore);

    // Resume → scoring works again.
    await host.getByTitle("Resume scoring").click();
    await typePrompt(page, "prompt typed after resume");
    await blurComposer(page);
    await waitForScore(page);
    await page.waitForTimeout(1500);
    expect(historyOf(await extStorage(context))[0]!.prompt).toBe("prompt typed after resume");
  });

  test("privacy + sync: only hashes/scores leave the device; event payload is correct", async ({
    context,
    page,
    net,
  }) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await resetExtension(context, page);
    await ensureOnboarded(page);

    // Enable cloud sync so events fire.
    const host = page.locator(HOST);
    await host.getByTitle("Team sync off (privacy-first)").click();
    await expect(host).toContainText("Team sync: on");

    const marker = `REVEALYST_PRIVACY_MARKER_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const prompt = `${marker} Write a short paragraph about privacy-first prompt analytics.`;
    await typePrompt(page, prompt);
    await blurComposer(page);
    await waitForScore(page);
    await page.waitForTimeout(3000); // allow LOG_EVENT + suggestions to fire

    const storage = await extStorage(context);
    const apiBase = (settingsOf(storage).apiBase as string) ?? DEFAULT_API_BASE;
    const anonId = settingsOf(storage).anonId as string;
    expect(anonId.length).toBeGreaterThan(0);

    const apiHost = new URL(apiBase).hostname;
    const apiCalls = net.requests.filter((r) => {
      try {
        return new URL(r.url()).hostname === apiHost;
      } catch {
        return false;
      }
    });
    expect(apiCalls.length).toBeGreaterThan(0);

    // 1) No Revealyst API request may contain any of the prompt text.
    for (const r of apiCalls) {
      const body = r.postData() ?? "";
      expect(body, `prompt text leaked in ${r.method()} ${r.url()}`).not.toContain(marker);
      expect(body, `prompt text leaked in ${r.method()} ${r.url()}`).not.toContain(
        "privacy-first prompt analytics",
      );
    }

    // 2) No request to any non-OpenAI domain may contain the marker.
    for (const r of net.requests) {
      if (!NON_LLM_DOMAINS(r)) continue;
      const body = r.postData() ?? "";
      expect(body, `marker found in request to ${r.url()}`).not.toContain(marker);
    }

    // 3) The event payload carries hash + metadata, and the hash is correct.
    const event = apiCalls.find((r) => r.url().includes("/api/event"));
    expect(event, "expected a LOG_EVENT to /api/event").toBeTruthy();
    const payload = JSON.parse(event!.postData() ?? "{}") as Record<string, unknown>;
    expect(payload.prompt_hash).toBe(sha256(prompt));
    expect(typeof payload.score).toBe("number");
    expect(Array.isArray(payload.flags)).toBe(true);
    expect(payload.llm_platform).toBe("chatgpt");
    expect(payload.user_anon_id).toBe(anonId);
    expect(JSON.stringify(payload)).not.toContain(marker);

    // 4) The suggestions request also only carries the hash + flags.
    const sugg = apiCalls.find((r) => r.url().includes("/api/suggestion"));
    expect(sugg, "expected a suggestion request").toBeTruthy();
    const sBody = JSON.parse(sugg!.postData() ?? "{}") as Record<string, unknown>;
    expect(sBody.prompt_hash).toBe(sha256(prompt));
    expect(JSON.stringify(sBody)).not.toContain(marker);

    // 5) anon id is stable — reload keeps the same id.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const storage2 = await extStorage(context);
    expect(settingsOf(storage2).anonId).toBe(anonId);
  });

  test("thumbs rating after a real ChatGPT response is stored locally", async ({
    context,
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await resetExtension(context, page);
    await ensureOnboarded(page);

    const host = page.locator(HOST);
    await expect(host.getByText("Rate after the LLM responds")).toBeVisible({ timeout: 15_000 });

    const prompt = "Reply with exactly the word: pong";
    await typePrompt(page, prompt);
    await (await getComposer(page)).press("Enter");
    await blurComposer(page);

    // Wait for the real ChatGPT response, then the thumbs appear. The thumbs
    // button is the user-visible spec §5.1 signal — wait on it directly
    // instead of chatgpt.com's message DOM (OpenAI A/B-tests two layouts with
    // different attributes, and this test must pass on both).
    await expect(host.getByText("Rate after the LLM responds")).toBeHidden({
      timeout: 120_000,
    });
    await expect(host.getByTitle("This prompt was helpful")).toBeVisible({
      timeout: 30_000,
    });

    // The score flush can lag the response by up to ~15s: the first score of a
    // session loads the ONNX model (fresh profile → no cache), and the thumbs
    // only depend on the response DOM. Poll until the scored entry lands.
    const matches = (h: Record<string, unknown>) =>
      norm((h.prompt as string) ?? "").trim() === prompt;
    await expect
      .poll(async () => historyOf(await extStorage(context)).some(matches), {
        timeout: 60_000,
      })
      .toBe(true);
    const before = historyOf(await extStorage(context));
    const entry = before.find(matches);
    expect(entry, "scored entry for the sent prompt should exist").toBeTruthy();

    // ChatGPT (signed-out sessions) can show a soft rate-limit bottom sheet
    // that covers the sidebar footer and intercepts the thumbs click. Dismiss
    // the native dialog before rating.
    const rl = page.locator("#no-auth-soft-rate-limit-dialog");
    if ((await rl.count()) > 0) {
      await page
        .evaluate(
          () =>
            (document.getElementById("no-auth-soft-rate-limit-dialog") as HTMLDialogElement | null)?.close(),
        )
        .catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(500);
    }
    await host.getByTitle("This prompt was helpful").click();
    await page.waitForTimeout(1500);

    const after = historyOf(await extStorage(context));
    const rated = after.find(matches);
    expect(rated?.rating).toBe(1);
  });
});
