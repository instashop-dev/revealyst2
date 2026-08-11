import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { requireAuth } from "../auth.js";
import type { AppEnv } from "../env.js";

const successResponse = z.object({ success: z.boolean() });
const errorResponse = z.object({ error: z.string(), message: z.string() });

const deleteAccountRoute = createRoute({
  method: "delete",
  path: "/api/account",
  middleware: [requireAuth],
  responses: {
    200: {
      content: { "application/json": { schema: successResponse } },
      description: "Account and all synced data erased",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

/** Account lifecycle (Settings → "Delete my data"). */
export const accountRoutes = new OpenAPIHono<AppEnv>();

accountRoutes.openapi(deleteAccountRoute, async (c) => {
  const db = await getDb(c.env);
  const repos = createRepos(db);
  // Erases the user's events, feedback, invites, library prompts and team
  // memberships in one transaction, then the user row itself. The session
  // token stops working immediately (the user no longer exists).
  await repos.users.deleteUserData(c.var.userId);
  return c.json({ success: true }, 200);
});
