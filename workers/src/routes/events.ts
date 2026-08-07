import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { optionalAuth } from "../auth.js";
import { createRateLimiter, rateLimit } from "../rate-limit.js";
import type { AppEnv } from "../env.js";

const sha256Hash = z.string().regex(/^[a-f0-9]{64}$/, "prompt_hash must be a SHA-256 hex digest");

const eventRequest = z.object({
  prompt_hash: sha256Hash,
  score: z.number().int().min(0).max(100),
  flags: z.array(z.string().min(1).max(100)).max(10).optional(),
  breakdown: z.record(z.string().max(32), z.number()).optional(),
  llm_platform: z.string().max(64).optional(),
  timestamp: z.string().datetime().optional(),
  team_id: z.string().uuid().optional(),
  user_anon_id: z.string().max(128).optional(),
  /** Thumbs up/down (-1 | 0 | 1) — spec §5.4 history rating. */
  rating: z.number().int().min(-1).max(1).optional(),
});
const errorResponse = z.object({ error: z.string(), message: z.string() });

const eventLimiter = rateLimit(createRateLimiter(300, 60_000), 300);

const route = createRoute({
  method: "post",
  path: "/api/event",
  middleware: [eventLimiter, optionalAuth],
  request: { body: { content: { "application/json": { schema: eventRequest } } } },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
      description: "Event logged",
    },
    400: { content: { "application/json": { schema: errorResponse } }, description: "Bad request" },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Team attribution requires a session",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not a team member",
    },
    429: {
      content: { "application/json": { schema: errorResponse } },
      description: "Rate limited",
    },
  },
});

export const eventsRoutes = new OpenAPIHono<AppEnv>();

eventsRoutes.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const userId = c.var.authUserId;
  const db = await getDb(c.env);
  const repos = createRepos(db);

  // Team attribution requires an authenticated, team-member session — an
  // anonymous client cannot inject events into a team (spec §6.4 auth + §5.5
  // dashboard integrity).
  const teamId = body.team_id ?? null;
  if (teamId) {
    if (!userId) {
      return c.json(
        { error: "unauthorized", message: "Team attribution requires signing in" },
        401,
      );
    }
    const member = await repos.teams.findMember(teamId, userId);
    if (!member) {
      return c.json({ error: "forbidden", message: "You are not a member of this team" }, 403);
    }
  }

  await repos.events.insert({
    userId,
    userAnonId: body.user_anon_id ?? "anon",
    teamId,
    promptHash: body.prompt_hash,
    score: body.score,
    breakdown: body.breakdown ?? {},
    flags: body.flags ?? [],
    llmPlatform: body.llm_platform ?? null,
    rating: body.rating ?? null,
    createdAt: body.timestamp,
  });
  return c.json({ success: true }, 200);
});
