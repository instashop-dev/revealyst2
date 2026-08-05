import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import type { AppEnv } from "../env.js";

const errorResponse = z.object({ error: z.string(), message: z.string() });

const route = createRoute({
  method: "post",
  path: "/api/feedback",
  middleware: [requireAuth],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ suggestion_id: z.string().max(128), was_accepted: z.boolean() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
      description: "Feedback recorded",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export const feedbackRoutes = new OpenAPIHono<AppEnv>();

feedbackRoutes.openapi(route, async (c) => {
  const { suggestion_id, was_accepted } = c.req.valid("json");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  await repos.feedback.insert(c.var.userId, suggestion_id, was_accepted);
  return c.json({ success: true }, 200);
});
