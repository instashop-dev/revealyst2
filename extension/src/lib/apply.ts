import type { Suggestion } from "../shared/types.js";

/**
 * One-click suggestion application (spec §5.3): manipulates the LLM input
 * DOM to prepend/append/insert the suggested preview text, then dispatches
 * native input events so the LLM page reacts as if the user typed.
 *
 * NB: contenteditable editors (ProseMirror etc.) render whitespace as
 * non-breaking spaces (U+00A0) in textContent; normalise them so captured
 * prompts are stable for scoring, history dedupe and saving.
 */
export function getInputText(el: HTMLElement): string {
  const raw =
    el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
      ? el.value
      : (el.textContent ?? "");
  return raw.replace(/\u00a0/g, " ");
}

export function setInputText(el: HTMLElement, text: string): void {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.value = text;
  } else if (el.isContentEditable) {
    el.textContent = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function applySuggestion(el: HTMLElement, suggestion: Suggestion): string {
  const current = getInputText(el);
  let next: string;
  switch (suggestion.action) {
    case "prepend":
      next = suggestion.preview + current;
      break;
    case "insert": {
      // Insert after the first sentence, preserving flow.
      const m = current.match(/^([^.!?]*[.!?])\s*/);
      const at = m && m[1] ? m[1].length : 0;
      next = current.slice(0, at) + suggestion.preview + current.slice(at);
      break;
    }
    case "append":
    default:
      next = current + suggestion.preview;
      break;
  }
  setInputText(el, next);
  return next;
}

/** Fallback insertion point for pages whose input is not yet visible. */
export function isEditable(el: HTMLElement | null): el is HTMLElement {
  return (
    el !== null &&
    (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || el.isContentEditable)
  );
}
