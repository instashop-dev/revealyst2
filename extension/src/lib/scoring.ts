import type { ScoreResult } from "@revealyst/scoring";
import { createOnnxEngine } from "./model-config.js";
import { sha256Hex } from "./hash.js";

const engine = createOnnxEngine();

export interface ScoreUpdate {
  result: ScoreResult;
  hash: string;
  /** The exact prompt text that was scored (used for local history). */
  prompt: string;
}

/**
 * Score a prompt locally (spec §5.2: rule-based scoring, <200ms, no prompt
 * text leaves the machine by default). Returns the hash used for analytics
 * events — the raw prompt is never transmitted.
 *
 * The engine prefers the local ONNX model when it loads (feature-extraction +
 * regression head); any model failure falls back to the rule engine, and the
 * failure is visible via result.meta.engine === "rules" +
 * result.meta.modelError (spec §7 "model unavailable" warning).
 */
export async function scorePrompt(prompt: string): Promise<ScoreUpdate> {
  const result = await engine.score(prompt);
  // Hash the trimmed text: LLM editors (ProseMirror) can leave invisible
  // trailing whitespace in the DOM, which would otherwise make the same
  // visible prompt hash differently across keystrokes — breaking cloud
  // dedupe and event correlation (spec §4 re-prompt rate).
  const hash = await sha256Hex(prompt.trim());
  return { result, hash, prompt };
}

/**
 * Debounced scorer for the live meter: scores 2 seconds after the user stops
 * typing (spec §5.1: capture on blur or every 2 seconds, debounced).
 */
export function createDebouncedScorer(delayMs = 2000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPrompt = "";

  function schedule(prompt: string, onResult: (update: ScoreUpdate) => void): void {
    if (timer) clearTimeout(timer);
    lastPrompt = prompt;
    timer = setTimeout(() => {
      void scorePrompt(lastPrompt).then(onResult);
    }, delayMs);
  }

  function flush(prompt: string, onResult: (update: ScoreUpdate) => void): void {
    if (timer) clearTimeout(timer);
    void scorePrompt(prompt).then(onResult);
  }

  function cancel(): void {
    if (timer) clearTimeout(timer);
  }

  return { schedule, flush, cancel };
}
