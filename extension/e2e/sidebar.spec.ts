import { expect, test } from "./fixture.js";

test.describe("Revealyst sidebar (mock ChatGPT page)", () => {
  test("shows onboarding, scores a prompt, and applies a suggestion", async ({ page }) => {
    await page.goto("/chatgpt.html");

    // Shadow-DOM sidebar is injected
    const host = page.locator("#revealyst-sidebar-host");
    await expect(host).toBeAttached({ timeout: 15_000 });
    await expect(host).toContainText("Welcome to Revealyst");

    // Finish onboarding
    await host.getByText("Got it — start coaching").click();
    await expect(host).toContainText("Prompt Quality Score");

    // Type a vague prompt → red score appears (debounced 2s + async)
    const input = page.locator("#prompt-textarea");
    await input.fill("Help me write something good.");
    await expect(host).toContainText(/red|score/i);

    // A suggestion becomes available (static fallback or vectorize+llm).
    // The first score of a session downloads the ONNX model (fresh profile →
    // no cache), so allow generous time for the suggestion fetch behind it.
    await expect(host.getByRole("button", { name: "Apply" }).first()).toBeVisible({
      timeout: 45_000,
    });

    // One-click apply prepends the preview into the LLM input
    await host.getByRole("button", { name: "Apply" }).first().click();
    const value = await input.inputValue();
    expect(value).toContain("Act as");
    expect(value).toContain("Help me write something good");
  });

  test("shows the missing-input fallback notice when no input exists (spec §7)", async ({
    page,
  }) => {
    await page.goto("/empty.html");
    const host = page.locator("#revealyst-sidebar-host");
    await expect(host).toBeAttached({ timeout: 15_000 });
    // Complete onboarding first; the input poll resolves after 15s with null
    // and the sidebar then shows the spec §7 fallback notice.
    await host.getByText("Got it — start coaching").click();
    await expect(host).toContainText("Revealyst can't find the input field", { timeout: 25_000 });
  });

  test("shows thumbs up/down after the LLM response appears (spec §5.1)", async ({ page }) => {
    await page.goto("/chatgpt.html");
    const host = page.locator("#revealyst-sidebar-host");
    await expect(host).toBeAttached({ timeout: 15_000 });
    await host.getByText("Got it — start coaching").click();
    // The mock page ships an assistant message, so the thumbs row is visible.
    await expect(host.getByTitle("This prompt was helpful")).toBeVisible();
    await expect(host.getByTitle("This prompt needs work")).toBeVisible();
  });

  test("sidebar collapses to a slim tab and expands back (spec §5.1)", async ({ page }) => {
    await page.goto("/chatgpt.html");
    const host = page.locator("#revealyst-sidebar-host");
    await expect(host).toBeAttached({ timeout: 15_000 });
    await host.getByText("Got it — start coaching").click();

    // Collapse → the scoring panel is replaced by a slim expand tab.
    await host.getByTitle("Collapse the panel to a slim tab").click();
    await expect(host).toContainText("Revealyst");
    await expect(host.getByText("Prompt Quality Score")).not.toBeVisible();

    // Expand → the full panel is back.
    await host.getByTitle("Expand Revealyst panel").click();
    await expect(host.getByText("Prompt Quality Score")).toBeVisible();
  });

  test("settings panel opens; save-to-library explains missing config (spec §5.6)", async ({
    page,
  }) => {
    await page.goto("/chatgpt.html");
    const host = page.locator("#revealyst-sidebar-host");
    await expect(host).toBeAttached({ timeout: 15_000 });
    await host.getByText("Got it — start coaching").click();

    // Open settings → token/team/history panel is present.
    await host.getByTitle("Settings — token, team, local history").click();
    await expect(host).toContainText("API token");
    await expect(host).toContainText("Personal prompt history");
    await host.getByRole("button", { name: "Close ✕" }).click();

    // Star without a configured token → actionable guidance, no API call.
    const input = page.locator("#prompt-textarea");
    await input.fill("Help me write something good.");
    await host.getByTitle("Save to library").click();
    await expect(host).toContainText("Connect your account in the Revealyst toolbar popup");
  });
});
