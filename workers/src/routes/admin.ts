import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { isAdminEmail, requireAdmin, signSessionToken } from "../auth.js";
import { runWeeklyDigest } from "../digest.js";
import { createRateLimiter, rateLimit } from "../rate-limit.js";
import type { AppEnv } from "../env.js";

const errorResponse = z.object({ error: z.string(), message: z.string() });

const adminUser = z.object({
  id: z.string(),
  email: z.string(),
  plan: z.string(),
  created_at: z.string(),
  last_active_at: z.string().nullable(),
  events_count: z.number(),
  teams: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })),
});

const listUsersRoute = createRoute({
  method: "get",
  path: "/api/admin/users",
  middleware: [requireAdmin],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ users: z.array(adminUser), total: z.number() }),
        },
      },
      description: "All signed-up users with MVP details (app creator only)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not the app creator",
    },
  },
});

const impersonateRoute = createRoute({
  method: "post",
  path: "/api/admin/impersonate",
  middleware: [requireAdmin],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ user_id: z.string().uuid() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            token: z.string(),
            user: z.object({
              id: z.string(),
              email: z.string(),
              plan: z.string(),
              is_admin: z.boolean(),
            }),
          }),
        },
      },
      description: "Session token for the impersonated user (app creator only)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not the app creator, or the target is also an app creator",
    },
    404: {
      content: { "application/json": { schema: errorResponse } },
      description: "User not found",
    },
  },
});

export const adminRoutes = new OpenAPIHono<AppEnv>();

adminRoutes.openapi(listUsersRoute, async (c) => {
  const db = await getDb(c.env);
  const repos = createRepos(db);
  const [users, memberships] = await Promise.all([
    repos.users.listAll(),
    repos.users.listTeamMemberships(),
  ]);
  const byUser = new Map<string, Array<{ id: string; name: string; role: string }>>();
  for (const m of memberships) {
    const list = byUser.get(m.user_id) ?? [];
    list.push({ id: m.team_id, name: m.team_name, role: m.role });
    byUser.set(m.user_id, list);
  }
  return c.json(
    {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        plan: u.plan,
        created_at: u.created_at,
        last_active_at: u.last_active_at,
        events_count: u.events_count,
        teams: byUser.get(u.id) ?? [],
      })),
      total: users.length,
    },
    200,
  );
});

adminRoutes.openapi(impersonateRoute, async (c) => {
  const { user_id } = c.req.valid("json");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  const user = await repos.users.getById(user_id);
  if (!user) {
    return c.json({ error: "not_found", message: "User not found" }, 404);
  }
  // Never issue an admin's credentials to another admin — an impersonated
  // session must not be able to reach admin endpoints.
  if (isAdminEmail(user.email, c.env)) {
    return c.json(
      { error: "forbidden", message: "App creator accounts cannot be impersonated" },
      403,
    );
  }
  const token = await signSessionToken(user.id, user.email, c.env.JWT_SECRET);
  // Audit trail for ops: which admin impersonated whom (ids only, no PII).
  console.log(`[admin] ${c.var.userId} impersonating ${user.id} at ${new Date().toISOString()}`);
  return c.json(
    {
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        is_admin: false,
      },
    },
    200,
  );
});

// A compromised admin session must not be able to flood every manager with
// SES mail — cap on-demand digest runs (once per 5 minutes is plenty for a
// manual trigger; the weekly cron is separate and rate-unbounded).
const digestLimiter = rateLimit(createRateLimiter(1, 300_000), 1);

const digestResponse = z.object({
  teams: z.number(),
  emails: z.number(),
  sent: z.number(),
  skipped: z.number(),
  errors: z.array(z.string()),
  dev: z.boolean(),
});

const digestRoute = createRoute({
  method: "post",
  path: "/api/admin/digest",
  middleware: [requireAdmin, digestLimiter],
  responses: {
    200: {
      content: { "application/json": { schema: digestResponse } },
      description: "Run the weekly manager digest on demand (app creator only)",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: errorResponse } },
      description: "Not the app creator",
    },
  },
});

adminRoutes.openapi(digestRoute, async (c) => {
  const summary = await runWeeklyDigest(c.env);
  return c.json(summary, 200);
});
