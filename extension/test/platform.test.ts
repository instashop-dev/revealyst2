// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { detectPlatform, findInput, waitForInput, PLATFORMS } from "../src/lib/platform.js";

describe("platform detection", () => {
  it("detects the three supported LLM platforms", () => {
    expect(detectPlatform("https://chat.openai.com/")?.id).toBe("chatgpt");
    expect(detectPlatform("https://claude.ai/new")?.id).toBe("claude");
    expect(detectPlatform("https://gemini.google.com/app")?.id).toBe("gemini");
  });

  it("returns undefined for unsupported pages", () => {
    expect(detectPlatform("https://example.com")).toBeUndefined();
  });

  it("honours user selector overrides (configurable platform list, spec §5.1)", () => {
    const overridden = detectPlatform("https://chat.openai.com/", {
      chatgpt: "[data-custom-input]",
    });
    expect(overridden?.inputSelectors[0]).toBe("[data-custom-input]");
  });

  it("covers every platform with resilient selectors", () => {
    for (const p of PLATFORMS) {
      expect(p.inputSelectors.length).toBeGreaterThan(1);
      expect(p.responseSelectors.length).toBeGreaterThan(0);
    }
  });
});

describe("input finding (happy-dom)", () => {
  it("finds the ChatGPT textarea by its data-attribute selector", () => {
    document.body.innerHTML = `<form><textarea id="prompt-textarea" placeholder="Send a message"></textarea></form>`;
    const platform = detectPlatform("https://chat.openai.com/");
    const input = findInput(document, platform!);
    expect(input?.id).toBe("prompt-textarea");
  });

  it("resolves null when no selector matches", () => {
    document.body.innerHTML = `<div>nothing here</div>`;
    const platform = detectPlatform("https://chat.openai.com/");
    expect(findInput(document, platform!)).toBeNull();
  });

  it("waits for an asynchronously mounted input", async () => {
    document.body.innerHTML = `<div></div>`;
    const platform = detectPlatform("https://claude.ai/")!;
    const promise = waitForInput(document, platform, 2000, 100);
    setTimeout(() => {
      document.body.innerHTML = `<div contenteditable="true">Hello</div>`;
    }, 150);
    const input = await promise;
    expect(input?.isContentEditable).toBe(true);
  });
});
