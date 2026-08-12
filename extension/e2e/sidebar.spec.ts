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

    // One-click apply inserts the suggestion preview into the LLM input.
    await host.getByRole("button", { name: "Apply" }).first().click();
    const value = await input.inputValue();
    // The first non-advisory suggestion is applied (role coaching is advisory
    // and has no Apply button); the original prompt always survives.
    expect(value).toContain("Help me write something good");
    expect(value).not.toBe("Help me write something good");
  });

  test("onboarding demo is live: sample prompt is scored and its suggestion applies (spec §5.8)", async ({
    page,
  }) => {
    await page.goto("/chatgpt.html");
    const host = page.locator("#revealyst-sidebar-host");
    await expect(host).toBeAttached({ timeout: 15_000 });
    await expect(host).toContainText("Welcome to Revealyst");

    // Click "Try a sample prompt" → the sample is inserted and scored live.
    await host.getByRole("button", { name: "Try a sample prompt" }).click();
    const input = page.locator("#prompt-textarea");
    await expect(input).toHaveValue("Help me write something good for my team.");
    await expect(host.getByText(/scoring…|· (red|yellow|green)/)).toBeVisible({ timeout: 20_000 });

    // A real suggestion arrives and can be applied from inside the tutorial.
    await expect(host.getByRole("button", { name: "Apply" }).first()).toBeVisible({
      timeout: 45_000,
    });
    await host.getByRole("button", { name: "Apply" }).first().click();
    const value = await input.inputValue();
    expect(value).toContain("Help me write something good for my team.");

    // Finishing the tutorial shows the normal sidebar.
    await host.getByText("Got it — start coaching").click();
    await expect(host.getByText("Prompt Quality Score")).toBeVisible();
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

  test("star with an empty composer gives feedback instead of a silent no-op", async ({ page }) => {
    await page.goto("/chatgpt.html");
    const host = page.locator("#revealyst-sidebar-host");
    await expect(host).toBeAttached({ timeout: 15_000 });
    await host.getByText("Got it — start coaching").click();

    // Empty composer → clicking ⭐ now explains why nothing happened.
    await host.getByTitle("Save to library").click();
    await expect(host).toContainText("Type a prompt first — then save it to the library");
  });

  test("save settings keeps the panel open and confirms the save (no second trip)", async ({
    page,
  }) => {
    await page.goto("/chatgpt.html");
    const host = page.locator("#revealyst-sidebar-host");
    await expect(host).toBeAttached({ timeout: 15_000 });
    await host.getByText("Got it — start coaching").click();

    await host.getByTitle("Settings — token, team, local history").click();
    await expect(host).toContainText("API token");
    // Paste a token and save: the panel stays open with a confirmation, so the
    // team dropdown can load in the same visit (previously the panel closed
    // and teams only loaded on the next open).
    await host.locator('input[placeholder="Paste your session token"]').fill("test-token");
    await host.getByRole("button", { name: "Save settings" }).click();
    await expect(host).toContainText("Settings saved");
    await expect(host.getByRole("button", { name: "Close ✕" })).toBeVisible();
    // The panel did not close — the settings header is still on screen.
    await expect(host).toContainText("Team (save-to-library)");
    // Close via ✕ returns to the sidebar.
    await host.getByRole("button", { name: "Close ✕" }).click();
    await expect(host).toContainText("Prompt Quality Score");
  });
});
