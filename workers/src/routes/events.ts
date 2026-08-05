import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { createRateLimiter, rateLimit } from "../rate-limit.js";
import type { AppEnv } from "../env.js";

const eventRequest = z.object({
  prompt_hash: z.string().min(8),
  score: z.number().int().min(0).max(100),
  flags: z.array(z.string()).max(10).optional(),
  breakdown: z.record(z.string(), z.number()).optional(),
  llm_platform: z.string().max(64).optional(),
  timestamp: z.string().datetime().optional(),
  team_id: z.string().uuid().optional(),
  user_anon_id: z.string().max(128).optional(),
});
const errorResponse = z.object({ error: z.string(), message: z.string() });

const eventLimiter = rateLimit(createRateLimiter(300, 60_000), 300);

const route = createRoute({
  method: "post",
  path: "/api/event",
  middleware: [eventLimiter],
  request: { body: { content: { "application/json": { schema: eventRequest } } } },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
      description: "Event logged",
    },
    400: { content: { "application/json": { schema: errorResponse } }, description: "Bad request" },
    429: {
      content: { "application/json": { schema: errorResponse } },
      description: "Rate limited",
    },
  },
});

export const eventsRoutes = new OpenAPIHono<AppEnv>();

eventsRoutes.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  await repos.events.insert({
    userAnonId: body.user_anon_id ?? "anon",
    teamId: body.team_id ?? null,
    promptHash: body.prompt_hash,
    score: body.score,
    breakdown: body.breakdown ?? {},
    flags: body.flags ?? [],
    llmPlatform: body.llm_platform ?? null,
    createdAt: body.timestamp,
  });
  return c.json({ success: true }, 200);
});
