import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import type { AppEnv } from "../env.js";

const errorResponse = z.object({ error: z.string(), message: z.string() });

const dashboardResponse = z.object({
  team_id: z.string(),
  period: z.string(),
  avg_score: z.number().nullable(),
  common_weaknesses: z.array(z.object({ flag: z.string(), count: z.number() })),
  top_prompts: z.array(
    z.object({ prompt_hash: z.string(), best_score: z.number(), occurrences: z.number() }),
  ),
  volume_by_platform: z.array(z.object({ llm_platform: z.string().nullable(), count: z.number() })),
  volume_by_day: z.array(z.object({ day: z.string(), count: z.number() })),
  trends_by_user: z.array(z.object({ user: z.string(), day: z.string(), avg_score: z.number() })),
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
  const stats = await repos.events.teamStats(team_id, since);

  // Pseudonymisation: real identities are never exposed. Events carry a
  // client-side hashed user_anon_id; the dashboard maps each distinct id to a
  // stable "User X" pseudonym (spec §5.5). Identifiable aliases require the
  // explicit opt-in flow (hardening item).
  const distinctUsers = [...new Set(stats.trendByUser.map((t) => t.user_anon_id))].sort();
  const pseudonym = new Map(
    distinctUsers.map((id, index) => [id, `User ${String.fromCharCode(65 + (index % 26))}`]),
  );

  return c.json(
    {
      team_id,
      period,
      avg_score: stats.avgScore7d,
      common_weaknesses: stats.commonWeaknesses,
      top_prompts: stats.topPrompts,
      volume_by_platform: stats.volumeByPlatform,
      volume_by_day: stats.volumeByDay,
      trends_by_user: stats.trendByUser.map((t) => ({
        user: pseudonym.get(t.user_anon_id) ?? "User ?",
        day: t.day,
        avg_score: t.avg_score,
      })),
    },
    200,
  );
});
