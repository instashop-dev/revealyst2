import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import type { AppEnv } from "../env.js";

const errorResponse = z.object({ error: z.string(), message: z.string() });

const historyEvent = z.object({
  prompt_hash: z.string(),
  score: z.number().nullable(),
  breakdown: z.record(z.string(), z.number()).nullable(),
  flags: z.array(z.string()).nullable(),
  llm_platform: z.string().nullable(),
  rating: z.number().nullable(),
  created_at: z.string(),
});

const route = createRoute({
  method: "get",
  path: "/api/history",
  middleware: [requireAuth],
  request: {
    query: z.object({
      period: z.enum(["7d", "30d", "all"]).default("30d"),
      platform: z.string().max(64).optional(),
      min_score: z.coerce.number().int().min(0).max(100).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(historyEvent),
            /** Raw prompt text is never stored server-side (spec §5.7) —
             *  snippets are only available in the extension's local history. */
            note: z.string(),
          }),
        },
      },
      description: "The user's own anonymised prompt events (scores only, no text)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export const historyRoutes = new OpenAPIHono<AppEnv>();

historyRoutes.openapi(route, async (c) => {
  const { period, platform, min_score } = c.req.valid("query");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  const sinceIso =
    period === "all"
      ? new Date(0).toISOString()
      : new Date(Date.now() - Number(period.slice(0, -1)) * 86_400_000).toISOString();
  const events = await repos.events.userHistory(c.var.userId, sinceIso, {
    platform,
    minScore: min_score,
  });
  return c.json(
    {
      events: events.map((e) => ({
        prompt_hash: e.prompt_hash,
        score: e.score,
        breakdown: e.breakdown,
        flags: e.flags,
        llm_platform: e.llm_platform,
        rating: e.rating ?? null,
        created_at: e.created_at,
      })),
      note: "Prompt text never leaves your device — snippets are available in the extension's local history.",
    },
    200,
  );
});
