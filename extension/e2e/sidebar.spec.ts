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

    // A suggestion becomes available (static fallback or vectorize+llm)
    await expect(host.getByRole("button", { name: "Apply" }).first()).toBeVisible({
      timeout: 20_000,
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
});
