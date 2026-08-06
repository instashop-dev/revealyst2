import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import type { AppEnv } from "../env.js";

const errorResponse = z.object({ error: z.string(), message: z.string() });

const statsResponse = z.object({
  period: z.string(),
  prompts_count: z.number(),
  green_count: z.number(),
  avg_score: z.number().nullable(),
  accepted_count: z.number(),
  clarity_count: z.number(),
  format_count: z.number(),
  shared_count: z.number(),
  streak_days: z.number(),
  trend: z.array(z.object({ day: z.string(), avg_score: z.number() })),
  radar: z.record(z.string(), z.number()),
});

const route = createRoute({
  method: "get",
  path: "/api/stats",
  middleware: [requireAuth],
  request: {
    query: z.object({ period: z.enum(["7d", "30d"]).default("30d") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: statsResponse } },
      description: "Personal progress stats (spec §5.4)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export const statsRoutes = new OpenAPIHono<AppEnv>();

statsRoutes.openapi(route, async (c) => {
  const { period } = c.req.valid("query");
  const days = period === "7d" ? 7 : 30;
  const db = await getDb(c.env);
  const repos = createRepos(db);
  const [stats, accepted, shared] = await Promise.all([
    repos.events.personalStats(c.var.userId, days),
    repos.feedback.countAccepted(c.var.userId),
    repos.library.countSharedBy(c.var.userId),
  ]);
  return c.json(
    {
      period: stats.period,
      prompts_count: stats.promptsCount,
      green_count: stats.greenCount,
      avg_score: stats.avgScore,
      accepted_count: accepted,
      clarity_count: stats.clarityCount,
      format_count: stats.formatCount,
      shared_count: shared,
      streak_days: stats.streakDays,
      trend: stats.trend,
      radar: stats.radar,
    },
    200,
  );
});
