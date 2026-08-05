import type { ScoreEventPayload, SuggestionResponse } from "../shared/types.js";
import { sha256Hex } from "../lib/hash.js";

/**
 * Typed client for the Revealyst API, called from the service worker
 * (extension origin — no CORS constraints). Failures throw; callers decide
 * whether to fall back (suggestions fall back client-side per spec §7).
 */
export async function fetchSuggestions(
  apiBase: string,
  flags: string[],
  breakdown?: Record<string, number>,
): Promise<SuggestionResponse> {
  const res = await fetch(`${apiBase}/api/suggestion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flags, score_breakdown: breakdown ?? undefined }),
  });
  if (!res.ok) throw new Error(`suggestion failed: ${res.status}`);
  return (await res.json()) as SuggestionResponse;
}

/** Log an anonymised prompt event (only hashes/scores leave the device). */
export async function logEvent(apiBase: string, payload: ScoreEventPayload): Promise<void> {
  const res = await fetch(`${apiBase}/api/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`event failed: ${res.status}`);
}

/** Save a prompt to the team library (encrypted at rest on the server). */
export async function saveToLibrary(
  apiBase: string,
  payload: { team_id: string; prompt_text: string; title?: string; tags?: string[]; score: number },
): Promise<{ id: string }> {
  const res = await fetch(`${apiBase}/api/library`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `library failed: ${res.status}`);
  }
  return (await res.json()) as { id: string };
}

export async function requestMagicLink(apiBase: string, email: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/auth/magic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`magic link failed: ${res.status}`);
}

export { sha256Hex };
