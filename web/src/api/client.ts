import type {
  AdminUser,
  DashboardResponse,
  HistoryResponse,
  LibraryCard,
  LibraryDetail,
  LibraryVersion,
  Session,
  StatsResponse,
  Team,
  TeamInvite,
  TeamMember,
  User,
} from "./types.js";

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  "https://revealyst-workers.thapi.workers.dev";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thin fetch wrapper. `init.method` selects the verb (GET/POST/PATCH/…) — the
 * JSON `Content-Type` header is set for every call so POST/PATCH bodies work.
 */
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

  // --- Account -----------------------------------------------------------------

  /** Erase the account and all synced data (Settings → "Delete my data"). */
  deleteAccount(token: string): Promise<{ success: boolean }> {
    return request("/api/account", { method: "DELETE", headers: authed(token) });
  },

  // --- Admin (app creator) --------------------------------------------------

  adminUsers(token: string): Promise<{ users: AdminUser[]; total: number }> {
    return request("/api/admin/users", { headers: authed(token) });
  },

  /** App creator only: start a session as the given user (impersonation). */
  adminImpersonate(token: string, userId: string): Promise<Session> {
    return request("/api/admin/impersonate", {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify({ user_id: userId }),
    });
  },

  // --- Teams -----------------------------------------------------------------

  myTeams(token: string): Promise<{ teams: Team[] }> {
    return request("/api/teams", { headers: authed(token) });
  },

  createTeam(token: string, name: string): Promise<Team> {
    return request("/api/team", {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify({ name }),
    });
  },

  inviteMember(
    token: string,
    teamId: string,
    email: string,
    role: "member" | "manager" = "member",
  ): Promise<{ message: string; invite_id: string; dev_link?: string }> {
    return request("/api/team/invite", {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify({ team_id: teamId, email, role }),
    });
  },

  teamInvites(token: string, teamId: string): Promise<{ invites: TeamInvite[] }> {
    return request(`/api/team/invites?team_id=${encodeURIComponent(teamId)}`, {
      headers: authed(token),
    });
  },

  revokeInvite(token: string, inviteId: string): Promise<{ message: string }> {
    return request(`/api/team/invites/${encodeURIComponent(inviteId)}/revoke`, {
      method: "POST",
      headers: authed(token),
    });
  },

  resendInvite(token: string, inviteId: string): Promise<{ message: string; dev_link?: string }> {
    return request(`/api/team/invites/${encodeURIComponent(inviteId)}/resend`, {
      method: "POST",
      headers: authed(token),
    });
  },

  teamMembers(
    token: string,
    teamId: string,
  ): Promise<{
    members: TeamMember[];
    anonymize_identities: boolean;
    identifiable_enabled: boolean;
  }> {
    return request(`/api/team/members?team_id=${encodeURIComponent(teamId)}`, {
      headers: authed(token),
    });
  },

  teamOptIn(
    token: string,
    teamId: string,
    enabled: boolean,
  ): Promise<{ opt_in_identifiable: boolean; identifiable_enabled: boolean }> {
    return request("/api/team/opt-in", {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify({ team_id: teamId, enabled }),
    });
  },

  teamSettings(token: string, teamId: string, anonymizeIdentities: boolean): Promise<Team> {
    return request("/api/team/settings", {
      method: "PATCH",
      headers: authed(token),
      body: JSON.stringify({ team_id: teamId, anonymize_identities: anonymizeIdentities }),
    });
  },

  // --- Personal analytics ----------------------------------------------------

  history(
    token: string,
    period: "7d" | "30d" | "all" = "all",
    platform?: string,
    minScore?: number,
  ): Promise<HistoryResponse> {
    const qs = new URLSearchParams({ period });
    if (platform) qs.set("platform", platform);
    if (minScore !== undefined) qs.set("min_score", String(minScore));
    return request(`/api/history?${qs}`, { headers: authed(token) });
  },

  stats(token: string, period: "7d" | "30d" = "7d"): Promise<StatsResponse> {
    return request(`/api/stats?period=${period}`, { headers: authed(token) });
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

  // --- Prompt library --------------------------------------------------------

  libraryList(
    token: string,
    teamId: string,
    params: {
      search?: string;
      tag?: string;
      minScore?: number;
      sort?: "most_used" | "highest_score" | "newest";
      page?: number;
    } = {},
  ): Promise<{ prompts: LibraryCard[]; total: number }> {
    const qs = new URLSearchParams({ team_id: teamId });
    if (params.search) qs.set("search", params.search);
    if (params.tag) qs.set("tag", params.tag);
    if (params.minScore !== undefined) qs.set("min_score", String(params.minScore));
    if (params.sort) qs.set("sort", params.sort);
    if (params.page !== undefined) qs.set("page", String(params.page));
    return request(`/api/library?${qs}`, { headers: authed(token) });
  },

  librarySave(
    token: string,
    body: { team_id: string; prompt_text: string; title?: string; tags?: string[]; score?: number },
  ): Promise<LibraryCard> {
    return request("/api/library", {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify(body),
    });
  },

  libraryGet(token: string, id: string): Promise<LibraryDetail> {
    return request(`/api/library/${encodeURIComponent(id)}`, { headers: authed(token) });
  },

  libraryPatch(
    token: string,
    id: string,
    patch: {
      title?: string;
      tags?: string[];
      notes?: string | null;
      is_standard?: boolean;
      prompt_text?: string;
      score?: number;
    },
  ): Promise<LibraryCard> {
    return request(`/api/library/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: authed(token),
      body: JSON.stringify(patch),
    });
  },

  libraryVersions(token: string, id: string): Promise<{ versions: LibraryVersion[] }> {
    return request(`/api/library/${encodeURIComponent(id)}/versions`, {
      headers: authed(token),
    });
  },

  libraryDelete(token: string, id: string): Promise<{ message: string }> {
    return request(`/api/library/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authed(token),
    });
  },
};
