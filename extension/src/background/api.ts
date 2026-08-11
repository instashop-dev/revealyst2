import type { ScoreEventPayload, SuggestionResponse } from "../shared/types.js";
import { sha256Hex } from "../lib/hash.js";

/** Error carrying the HTTP status so callers can branch (e.g. retry without team). */
export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 2): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      return res;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function fetchSuggestions(
  apiBase: string,
  flags: string[],
  breakdown?: Record<string, number>,
  promptHash?: string,
): Promise<SuggestionResponse> {
  const res = await fetchWithRetry(`${apiBase}/api/suggestion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt_hash: promptHash,
      flags,
      score_breakdown: breakdown ?? undefined,
    }),
  });
  if (!res.ok) throw new Error(`suggestion failed: ${res.status}`);
  return (await res.json()) as SuggestionResponse;
}

/** Log an anonymised prompt event (only hashes/scores leave the device). */
export async function logEvent(
  apiBase: string,
  payload: ScoreEventPayload,
  token?: string,
): Promise<void> {
  const res = await fetchWithRetry(`${apiBase}/api/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new ApiHttpError(res.status, `event failed: ${res.status}`);
}

/** Save a prompt to the team library (encrypted at rest on the server). */
export async function saveToLibrary(
  apiBase: string,
  payload: { team_id: string; prompt_text: string; title?: string; tags?: string[]; score: number },
  token?: string,
): Promise<{ id: string }> {
  const res = await fetchWithRetry(`${apiBase}/api/library`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `library failed: ${res.status}`);
  }
  return (await res.json()) as { id: string };
}

/** Record suggestion acceptance feedback (spec §5.6 suggestions_feedback). */
export async function postFeedback(
  apiBase: string,
  token: string,
  suggestionId: string,
  wasAccepted: boolean,
): Promise<void> {
  const res = await fetchWithRetry(`${apiBase}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ suggestion_id: suggestionId, was_accepted: wasAccepted }),
  });
  if (!res.ok) throw new Error(`feedback failed: ${res.status}`);
}

/** The signed-in user's teams (settings panel — pick where to save). */
export async function fetchTeams(
  apiBase: string,
  token: string,
): Promise<Array<{ id: string; name: string; role: string }>> {
  const res = await fetchWithRetry(`${apiBase}/api/teams`, {
    method: "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`teams failed: ${res.status}`);
  const body = (await res.json()) as { teams?: Array<{ id: string; name: string; role: string }> };
  return body.teams ?? [];
}

export async function requestMagicLink(apiBase: string, email: string): Promise<void> {
  const res = await fetchWithRetry(`${apiBase}/api/auth/magic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new ApiHttpError(res.status, `magic link failed: ${res.status}`);
}

/** Fetch the current user for a session token — validates the token
 *  (popup "Connect with token" path). Throws ApiHttpError(401) when invalid. */
export async function fetchMe(
  apiBase: string,
  token: string,
): Promise<{ id: string; email: string; plan: string; is_admin: boolean }> {
  const res = await fetchWithRetry(`${apiBase}/api/auth/me`, {
    method: "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiHttpError(res.status, `me failed: ${res.status}`);
  return (await res.json()) as { id: string; email: string; plan: string; is_admin: boolean };
}

/** Exchange a magic-link token for a session token (popup email path). */
export async function verifyMagicToken(
  apiBase: string,
  token: string,
): Promise<{ token: string; email: string }> {
  const res = await fetchWithRetry(`${apiBase}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new ApiHttpError(res.status, `verify failed: ${res.status}`);
  const body = (await res.json()) as { token: string; user?: { email?: string } };
  return { token: body.token, email: body.user?.email ?? "" };
}

export { sha256Hex };
