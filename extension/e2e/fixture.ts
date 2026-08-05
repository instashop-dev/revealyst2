import { test as base, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

/**
 * Launches Chromium with the built extension loaded (headless new supports
 * extensions). Requires `npm run build -w extension` first — CI builds before
 * the e2e job.
 */
export const test = base.extend<{ context: BrowserContext }>({
  context: async (_fixtures, use) => {
    const context = await chromium.launchPersistentContext("", {
      // channel chromium = full build (new headless supports extensions;
      // the default headless-shell build does not).
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
});

export { expect } from "@playwright/test";
