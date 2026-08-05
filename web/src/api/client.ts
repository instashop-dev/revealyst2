import type { DashboardResponse, LibraryCard, Session, User } from "./types.js";

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  "https://revealyst-workers.thapi.workers.dev";

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

function authed(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

export const api = {
  requestMagicLink(email: string): Promise<{ message: string }> {
    return request("/api/auth/magic", { method: "POST", body: JSON.stringify({ email }) });
  },

  verifyMagicToken(token: string): Promise<Session> {
    return request("/api/auth/verify", { method: "POST", body: JSON.stringify({ token }) });
  },

  me(token: string): Promise<User> {
    return request("/api/auth/me", { headers: authed(token) });
  },

  libraryList(
    token: string,
    teamId: string,
    params: { search?: string; tag?: string; page?: number } = {},
  ): Promise<{ prompts: LibraryCard[]; total: number }> {
    const qs = new URLSearchParams({ team_id: teamId, ...(params as Record<string, string>) });
    return request(`/api/library?${qs}`, { headers: authed(token) });
  },

  libraryGet(
    token: string,
    id: string,
  ): Promise<{ id: string; prompt_text: string; title: string | null }> {
    return request(`/api/library/${id}`, { headers: authed(token) });
  },

  teamDashboard(
    token: string,
    teamId: string,
    period: "7d" | "30d" = "7d",
  ): Promise<DashboardResponse> {
    return request(`/api/team/dashboard?team_id=${teamId}&period=${period}`, {
      headers: authed(token),
    });
  },
};

export { ApiError };
