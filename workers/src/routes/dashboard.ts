import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import { displayNameFromEmail } from "./teams.js";
import type { AppEnv } from "../env.js";

const errorResponse = z.object({ error: z.string(), message: z.string() });

const dashboardResponse = z.object({
  team_id: z.string(),
  period: z.string(),
  avg_score: z.number().nullable(),
  common_weaknesses: z.array(z.object({ flag: z.string(), count: z.number() })),
  /** Team library top prompts — copyable (raw prompt text is never stored
   *  from events, so top prompts are the team's voluntarily saved prompts). */
  top_prompts: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      score: z.number().nullable(),
      usage_count: z.number(),
      version: z.number(),
      is_standard: z.boolean(),
      contributor: z.string(),
      created_at: z.string(),
    }),
  ),
  volume_by_platform: z.array(z.object({ llm_platform: z.string().nullable(), count: z.number() })),
  volume_by_day: z.array(z.object({ day: z.string(), count: z.number() })),
  score_by_day: z.array(z.object({ day: z.string(), avg_score: z.number() })),
  trends_by_user: z.array(z.object({ user: z.string(), day: z.string(), avg_score: z.number() })),
  /** True when the manager switched identifiable mode off AND every member
   *  opted in (spec §5.5 — hard enforced). */
  identifiable: z.boolean(),
});

const route = createRoute({
  method: "get",
  path: "/api/team/dashboard",
  middleware: [requireAuth],
  request: {
    query: z.object({
      team_id: z.string().uuid(),
      period: z.enum(["7d", "30d"]).default("7d"),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: dashboardResponse } },
      description: "Anonymised team analytics",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not a manager",
    },
  },
});

export const dashboardRoutes = new OpenAPIHono<AppEnv>();

dashboardRoutes.openapi(route, async (c) => {
  const { team_id, period } = c.req.valid("query");
  const db = await getDb(c.env);
  const repos = createRepos(db);

  if (!(await repos.teams.isManager(team_id, c.var.userId))) {
    return c.json(
      { error: "forbidden", message: "Only team managers can view the dashboard" },
      403,
    );
  }

  const days = period === "30d" ? 30 : 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [stats, team, topRows, members] = await Promise.all([
    repos.events.teamStats(team_id, since),
    repos.teams.findById(team_id),
    repos.library.topForTeam(team_id, 5),
    repos.teams.listMembersWithUsers(team_id),
  ]);

  // Identifiable mode (spec §5.5): hard-enforced — requires the manager to
  // have turned anonymisation off AND every member to have opted in.
  const anonymize =
    (team?.settings as { anonymize_identities?: boolean } | null)?.anonymize_identities !== false;
  const allOptedIn = await repos.teams.allOptedIn(team_id);
  const identifiable = !anonymize && allOptedIn;

  const memberByUserId = new Map(members.map((m) => [m.user_id, m]));
  const nameFor = (userId: string | null): string => {
    const m = userId ? memberByUserId.get(userId) : undefined;
    if (!m) return "Member";
    return identifiable ? displayNameFromEmail(m.email, m.anon_alias) : (m.anon_alias ?? "Member");
  };

  // Pseudonymisation: events carry a client-side hashed user_anon_id; the
  // dashboard maps each distinct id to a stable "User X" pseudonym.
  const distinctUsers = [...new Set(stats.trendByUser.map((t) => t.user_anon_id))].sort();
  const pseudonym = new Map(
    distinctUsers.map((id, index) => [id, `User ${String.fromCharCode(65 + (index % 26))}`]),
  );

  // In identifiable mode, group trends by the authenticated user id (events
  // stamped with user_id); otherwise fall back to the anonymous id mapping.
  const trendByUser = identifiable
    ? [...new Map(stats.trendByUser.map((t) => [t.user_id ?? t.user_anon_id, t])).values()]
        .map((t) => ({
          user: nameFor(t.user_id),
          day: t.day,
          avg_score: t.avg_score,
        }))
        .sort((a, b) => a.user.localeCompare(b.user) || a.day.localeCompare(b.day))
    : stats.trendByUser.map((t) => ({
        user: pseudonym.get(t.user_anon_id) ?? "User ?",
        day: t.day,
        avg_score: t.avg_score,
      }));

  return c.json(
    {
      team_id,
      period,
      avg_score: stats.avgScore,
      common_weaknesses: stats.commonWeaknesses,
      top_prompts: topRows.map((p) => ({
        id: p.id,
        title: p.title,
        score: p.score,
        usage_count: p.usage_count,
        version: p.version,
        is_standard: p.is_standard,
        contributor: nameFor(p.created_by),
        created_at: p.created_at,
      })),
      volume_by_platform: stats.volumeByPlatform,
      volume_by_day: stats.volumeByDay,
      score_by_day: stats.avgScoreByDay,
      trends_by_user: trendByUser,
      identifiable,
    },
    200,
  );
});
