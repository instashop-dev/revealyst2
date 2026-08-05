import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { createRateLimiter, rateLimit } from "../rate-limit.js";
import { requireAuth, signMagicToken, signSessionToken } from "../auth.js";
import type { AppEnv } from "../env.js";

const magicRequest = z.object({ email: z.string().email() });
const verifyRequest = z.object({ token: z.string().min(1) });
const errorResponse = z.object({ error: z.string(), message: z.string() });
const magicLimiter = rateLimit(createRateLimiter(5, 60_000), 5);
const userResponse = z.object({ id: z.string(), email: z.string(), plan: z.string() });

const routes = {
  magic: createRoute({
    method: "post",
    path: "/api/auth/magic",
    middleware: [magicLimiter],
    request: { body: { content: { "application/json": { schema: magicRequest } } } },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ message: z.string(), dev_link: z.string().optional() }),
          },
        },
        description: "Magic link requested",
      },
      400: {
        content: { "application/json": { schema: errorResponse } },
        description: "Bad request",
      },
    },
  }),
  verify: createRoute({
    method: "post",
    path: "/api/auth/verify",
    request: { body: { content: { "application/json": { schema: verifyRequest } } } },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ token: z.string(), user: userResponse }),
          },
        },
        description: "Session created",
      },
      401: {
        content: { "application/json": { schema: errorResponse } },
        description: "Invalid token",
      },
    },
  }),
  me: createRoute({
    method: "get",
    path: "/api/auth/me",
    middleware: [requireAuth],
    responses: {
      200: {
        content: { "application/json": { schema: userResponse } },
        description: "Current user",
      },
      401: {
        content: { "application/json": { schema: errorResponse } },
        description: "Unauthorized",
      },
    },
  }),
};

export const authRoutes = new OpenAPIHono<AppEnv>();

authRoutes.openapi(routes.magic, async (c) => {
  const { email } = c.req.valid("json");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  let user = await repos.users.findByEmail(email);
  if (!user) {
    user = await repos.users.create(email);
  }
  const magicToken = await signMagicToken(user.id, user.email, c.env.JWT_SECRET);
  const devLink = `${c.env.APP_URL}/auth/verify?token=${magicToken}`;

  // NEVER log the link outside dev — magic links are working credentials.
  // TODO(SMTP): wire a transactional email provider (Resend/Cloudflare Email)
  // in production; the link is returned only in DEV_MODE.
  if (c.env.DEV_MODE === "true") {
    console.log(`[auth] dev magic link for ${email}: ${devLink}`);
    return c.json({ message: "link sent", dev_link: devLink }, 200);
  }
  return c.json({ message: "link sent" }, 200);
});

authRoutes.openapi(routes.verify, async (c) => {
  const { token } = c.req.valid("json");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  try {
    const { verifyToken } = await import("../auth.js");
    const payload = await verifyToken(token, c.env.JWT_SECRET);
    const user = await repos.users.getById(payload.userId);
    if (!user) return c.json({ error: "invalid_token", message: "User not found" }, 401);
    const sessionToken = await signSessionToken(user.id, user.email, c.env.JWT_SECRET);
    return c.json(
      { token: sessionToken, user: { id: user.id, email: user.email, plan: user.plan } },
      200,
    );
  } catch {
    return c.json({ error: "invalid_token", message: "Token is invalid or expired" }, 401);
  }
});

authRoutes.openapi(routes.me, async (c) => {
  const db = await getDb(c.env);
  const repos = createRepos(db);
  const user = await repos.users.getById(c.var.userId);
  if (!user) return c.json({ error: "unauthorized", message: "User not found" }, 401);
  return c.json({ id: user.id, email: user.email, plan: user.plan }, 200);
});
