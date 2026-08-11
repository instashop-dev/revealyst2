/**
 * Supported LLM platforms (spec §5.1: chat.openai.com, claude.ai,
 * gemini.google.com, plus any configurable list). Selectors are deliberately
 * layered: data-attribute/resilient selectors first, structural fallbacks
 * second, so a redesign degrades to a notice instead of breaking (spec §7).
 */
export interface PlatformDef {
  id: string;
  name: string;
  urlPattern: RegExp;
  inputSelectors: string[];
  responseSelectors: string[];
}

export const PLATFORMS: PlatformDef[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    // ChatGPT moved from chat.openai.com to chatgpt.com (server-side
    // redirect); match both so the sidebar still injects on the live site.
    urlPattern: /(chat\.openai\.com|chatgpt\.com)/,
    inputSelectors: [
      "#prompt-textarea",
      "form textarea",
      "div[contenteditable='true']",
      "[data-testid='prompt-input']",
    ],
    responseSelectors: [
      // Primary: the classic turn DOM. ChatGPT A/B-tests a new message layout
      // that drops data-message-author-role entirely, so also match the
      // assistant turn's response-action row, which both layouts render once a
      // reply exists (prefix match tolerates label churn: "Copy", "Copy
      // response", …).
      "[data-message-author-role='assistant']",
      "button[aria-label='Copy response']",
      "button[aria-label^='Copy']",
    ],
  },
  {
    id: "claude",
    name: "Claude",
    urlPattern: /claude\.ai/,
    inputSelectors: [
      "div[contenteditable='true']",
      "textarea",
      "[contenteditable='plaintext-only']",
    ],
    responseSelectors: ["[data-testid='assistant-message']", "[data-is-streaming]"],
  },
  {
    id: "gemini",
    name: "Gemini",
    urlPattern: /gemini\.google\.com/,
    inputSelectors: [
      "rich-textarea div[contenteditable='true']",
      "rich-textarea textarea",
      "textarea",
    ],
    responseSelectors: ["message-content", ".model-response-text"],
  },
  // E2E fixture only: local mock LLM pages used by Playwright (not reachable
  // by production users, who do not browse LLM pages on localhost).
  {
    id: "mock-llm",
    name: "Mock LLM (e2e)",
    urlPattern: /(localhost|127\.0\.0\.1)/,
    inputSelectors: ["#prompt-textarea", "textarea", "div[contenteditable='true']"],
    responseSelectors: [".mock-response"],
  },
];

/** Detect the platform for a URL, honouring user-provided selector overrides. */
export function detectPlatform(
  url: string,
  overrides: Record<string, string> = {},
): PlatformDef | undefined {
  const base = PLATFORMS.find((p) => p.urlPattern.test(url));
  if (!base) return undefined;
  const override = overrides[base.id];
  if (!override) return base;
  return { ...base, inputSelectors: [override, ...base.inputSelectors] };
}

/** Find the prompt input element using the platform's resilient selectors.
 *  Selectors are consulted in priority order; within a selector's matches we
 *  skip hidden fallback elements (e.g. ChatGPT's screen-reader textarea) and
 *  prefer a contenteditable editor over a plain textarea. In jsdom/happy-dom
 *  there is no layout, so visibility checks are disabled there to keep unit
 *  tests deterministic. */
export function findInput(doc: Document, platform: PlatformDef): HTMLElement | null {
  const hasLayout = doc.documentElement.clientWidth > 0 || doc.documentElement.clientHeight > 0;
  for (const selector of platform.inputSelectors) {
    const matches: HTMLElement[] = [];
    for (const el of doc.querySelectorAll(selector)) {
      if (el instanceof HTMLElement && (!hasLayout || isVisibleForInput(el))) matches.push(el);
    }
    if (matches.length === 0) continue;
    // The contenteditable editor is the real composer; plain textareas are
    // often invisible a11y fallbacks on modern LLM pages.
    return matches.find((el) => el.isContentEditable) ?? matches[0] ?? null;
  }
  return null;
}

function isVisibleForInput(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  // Some fallbacks keep a real layout box but are transparent (opacity 0).
  if (typeof getComputedStyle === "function" && getComputedStyle(el).opacity === "0") return false;
  return true;
}

/**
 * Poll for the input element (LLM pages mount asynchronously). Resolves null
 * after `timeoutMs` so the UI can show the spec §7 fallback notice.
 */
export function waitForInput(
  doc: Document,
  platform: PlatformDef,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const el = findInput(doc, platform);
      if (el) return resolve(el);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
