// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { appliedMessage, applySuggestion, getInputText, setInputText } from "../src/lib/apply.js";
import type { Suggestion } from "../src/shared/types.js";

describe("suggestion application (spec §5.3 one-click apply)", () => {
  it("prepends to a textarea", () => {
    const ta = document.createElement("textarea");
    ta.value = "Write a blog post.";
    const suggestion: Suggestion = {
      id: "add_role",
      type: "add_role",
      text: "Add a role",
      preview: "Act as a senior copywriter. ",
      action: "prepend",
    };
    applySuggestion(ta, suggestion);
    expect(ta.value).toBe("Act as a senior copywriter. Write a blog post.");
  });

  it("appends to a contenteditable", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    div.textContent = "Summarise this";
    const suggestion: Suggestion = {
      id: "add_output_format",
      type: "add_output_format",
      text: "Add format",
      preview: " Answer as a bulleted list.",
      action: "append",
    };
    applySuggestion(div, suggestion);
    expect(div.textContent).toBe("Summarise this Answer as a bulleted list.");
  });

  it("inserts after the first sentence", () => {
    const ta = document.createElement("textarea");
    ta.value = "Draft an email. Keep it short.";
    const suggestion: Suggestion = {
      id: "add_context",
      type: "add_context",
      text: "Add context",
      preview: " For context: we are a SaaS team.",
      action: "insert",
    };
    applySuggestion(ta, suggestion);
    expect(ta.value).toBe("Draft an email. For context: we are a SaaS team. Keep it short.");
  });

  it("round-trips text via getInputText/setInputText and dispatches input events", () => {
    const ta = document.createElement("textarea");
    ta.value = "before";
    let events = 0;
    ta.addEventListener("input", () => events++);
    setInputText(ta, "after");
    expect(getInputText(ta)).toBe("after");
    expect(events).toBeGreaterThan(0);
  });
});

describe("appliedMessage (one-click loop closure)", () => {
  it("celebrates a score improvement with the delta", () => {
    expect(appliedMessage({ preview: "X", before: 54, after: 78 })).toBe(
      "Score improved 54 → 78 🎉",
    );
  });

  it("shows the delta even when the score did not improve (honest loop closure)", () => {
    expect(appliedMessage({ preview: "X", before: 54, after: 54 })).toBe("Score 54 → 54");
    expect(appliedMessage({ preview: "X", before: 80, after: 72 })).toBe("Score 80 → 72");
  });

  it("handles the pre-re-score state (after not yet known)", () => {
    expect(appliedMessage({ preview: "X", before: 54, after: null })).toBe("Applied ✓");
    expect(appliedMessage({ preview: "X", before: null, after: null })).toBe("Applied ✓");
  });
});
