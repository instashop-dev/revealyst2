import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRepos } from "../db/index.js";
import { getDb } from "../db.js";
import { sendMagicLinkEmail } from "../email.js";
import { createRateLimiter, rateLimit } from "../rate-limit.js";
import { requireAuth, signMagicToken, signSessionToken, isAdminEmail } from "../auth.js";
import type { AppEnv } from "../env.js";

const magicRequest = z.object({ email: z.string().email() });
const verifyRequest = z.object({ token: z.string().min(1) });
const errorResponse = z.object({ error: z.string(), message: z.string() });
const magicLimiter = rateLimit(createRateLimiter(5, 60_000), 5);
const verifyLimiter = rateLimit(createRateLimiter(10, 60_000), 10);

/**
 * Per-recipient cooldown (in-memory, per isolate) so an attacker rotating IPs
 * cannot burn SES quota/domain reputation. Cloudflare-level rate limiting is
 * the additional production hardening layer (see docs/runbook.md).
 */
const lastEmailAt = new Map<string, number>();
const RECIPIENT_COOLDOWN_MS = 60_000;
const RECIPIENT_COOLDOWN_MAX_ENTRIES = 10_000;
const userResponse = z.object({
  id: z.string(),
  email: z.string(),
  plan: z.string(),
  /** True when this account is the app creator (ADMIN_EMAILS) — drives the Admin nav. */
  is_admin: z.boolean().default(false),
});

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
    middleware: [verifyLimiter],
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
  const { email: rawEmail } = c.req.valid("json");
  // Normalize so case/whitespace variants cannot bypass the recipient
  // cooldown or create duplicate users (the email column is unique).
  const email = rawEmail.trim().toLowerCase();
  const db = await getDb(c.env);
  const repos = createRepos(db);
  let user = await repos.users.findByEmail(email);
  if (!user) {
    user = await repos.users.create(email);
  }
  const magicToken = await signMagicToken(user.id, user.email, c.env.JWT_SECRET);
  // Record the jti so the link can be verified exactly once (single-use).
  try {
    await repos.magic.insert(magicToken.jti, user.id, magicToken.expiresAt);
  } catch (err) {
    // A link whose jti was not recorded will be rejected at verify; surface
    // loudly so ops can react, but keep the uniform 200 (anti-oracle).
    console.error("[auth] magic link jti insert failed:", err);
  }
  const devLink = `${c.env.APP_URL}/auth/verify?token=${magicToken.token}`;

  // NEVER log the link outside dev — magic links are working credentials.
  if (c.env.DEV_MODE === "true") {
    console.log(`[auth] dev magic link for ${email}: ${devLink}`);
    return c.json({ message: "link sent", dev_link: devLink }, 200);
  }

  if (c.env.SES_ACCESS_KEY_ID && c.env.SES_SECRET_ACCESS_KEY) {
    const now = Date.now();
    const last = lastEmailAt.get(email);
    if (last && now - last < RECIPIENT_COOLDOWN_MS) {
      // Silently succeed: do not reveal that a cooldown is active. Log only a
      // short hash of the address (no recipient PII in the log stream).
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
      const tag = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 12);
      console.log(`[auth] magic link suppressed (recipient cooldown): ${tag}`);
    } else {
      try {
        await sendMagicLinkEmail(
          {
            region: c.env.SES_REGION ?? "us-east-1",
            accessKeyId: c.env.SES_ACCESS_KEY_ID,
            secretAccessKey: c.env.SES_SECRET_ACCESS_KEY,
            fromEmail: c.env.SES_FROM_EMAIL ?? "Revealyst <noreply@e.revealyst.com>",
          },
          { to: email, magicLink: devLink },
        );
        lastEmailAt.set(email, now);
        if (lastEmailAt.size > RECIPIENT_COOLDOWN_MAX_ENTRIES) {
          lastEmailAt.clear(); // bound memory against spoofed-recipient floods
        }
        console.log("[auth] magic link emailed via SES");
      } catch (err) {
        // Uniform 200: never expose delivery state to the client (anti-oracle).
        // Delivery failures are tracked server-side via logs/observability.
        console.error("[auth] magic link email send failed:", err);
      }
    }
    return c.json({ message: "link sent" }, 200);
  }

  console.error("[auth] SES is not configured — cannot deliver magic link");
  return c.json({ message: "link sent" }, 200);
});

authRoutes.openapi(routes.verify, async (c) => {
  const { token } = c.req.valid("json");
  const db = await getDb(c.env);
  const repos = createRepos(db);
  try {
    const { verifyToken } = await import("../auth.js");
    const payload = await verifyToken(token, c.env.JWT_SECRET);
    // Only short-lived magic links may be exchanged for a session; a leaked
    // or replayed session token is rejected here.
    if (payload.tokenType !== "magic") {
      return c.json({ error: "invalid_token", message: "Token is invalid or expired" }, 401);
    }
    // Consume the jti atomically — a used (or unknown) link cannot be reused.
    const jti = payload.jti;
    if (!jti || !(await repos.magic.consume(jti))) {
      return c.json({ error: "invalid_token", message: "Token is invalid or expired" }, 401);
    }
    const user = await repos.users.getById(payload.userId);
    if (!user) return c.json({ error: "invalid_token", message: "User not found" }, 401);

    // Team invite (spec §5.8): the magic link carries a team_id claim —
    // verifying it auto-joins the invitee with the invited role and settles
    // the tracked invite row (pending → accepted). The join is gated on the
    // invite row being pending AND its live jti matching this token, so a
    // revoked or rotated link can never join or re-settle an invite.
    if (payload.teamId) {
      const invite = await repos.invites.findPendingByEmail(payload.teamId, user.email);
      const inviteValid = Boolean(
        invite && invite.status === "pending" && invite.jti === payload.jti,
      );
      const existing = await repos.teams.findMember(payload.teamId, user.id);
      let joined = Boolean(existing);
      if (!joined && inviteValid && invite) {
        try {
          await repos.teams.addMember(
            payload.teamId,
            user.id,
            invite.role === "manager" ? "manager" : "member",
          );
          joined = true;
        } catch (err) {
          // PK race with a concurrent verify of the same invite — non-fatal.
          console.error("[auth] auto-join team failed:", err);
        }
      }
      if (joined && inviteValid && invite) {
        try {
          await repos.invites.markAccepted(invite.id);
        } catch (err) {
          console.error("[auth] mark invite accepted failed:", err);
        }
      }
    }

    const sessionToken = await signSessionToken(user.id, user.email, c.env.JWT_SECRET);
    return c.json(
      {
        token: sessionToken,
        user: {
          id: user.id,
          email: user.email,
          plan: user.plan,
          is_admin: isAdminEmail(user.email, c.env),
        },
      },
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
  return c.json(
    {
      id: user.id,
      email: user.email,
      plan: user.plan,
      is_admin: isAdminEmail(user.email, c.env),
    },
    200,
  );
});
