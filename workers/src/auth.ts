import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { SignJWT, jwtVerify } from "jose";
import type { AppEnv } from "./env.js";
import { getDb } from "./db.js";
import { createRepos } from "./db/index.js";

const ISSUER = "revealyst";
const AUDIENCE = "revealyst-app";
const encoder = new TextEncoder();

export interface AuthPayload {
  userId: string;
  email: string;
  /** Distinguishes short-lived magic links from long-lived session tokens. */
  tokenType: "magic" | "session";
  /** Unique token id — magic links are consumed once via this. */
  jti: string | null;
  /** Team to auto-join on verify (invite flow, spec §5.8). */
  teamId: string | null;
}

export interface MagicToken {
  token: string;
  jti: string;
  expiresAt: string;
}

async function sign(
  payload: { email: string; token_type: "magic" | "session" },
  userId: string,
  secret: string,
  expiresIn: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(encoder.encode(secret));
}

/** Short-lived magic-link token (15 min) — only accepted by /api/auth/verify. */
export async function signMagicToken(
  userId: string,
  email: string,
  secret: string,
  teamId?: string,
): Promise<MagicToken> {
  const jti = crypto.randomUUID();
  const payload: Record<string, unknown> = { email, token_type: "magic" };
  if (teamId) payload.team_id = teamId;
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("15m")
    .setJti(jti)
    .sign(encoder.encode(secret));
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  return { token, jti, expiresAt };
}

/** Session token (7 days) — only accepted by the Bearer guard (requireAuth). */
export function signSessionToken(userId: string, email: string, secret: string): Promise<string> {
  return sign({ email, token_type: "session" }, userId, secret, "7d");
}

export async function verifyToken(token: string, secret: string): Promise<AuthPayload> {
  const { payload } = await jwtVerify(token, encoder.encode(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!payload.sub) throw new Error("missing subject");
  const tokenType = payload.token_type === "session" ? "session" : "magic";
  return {
    userId: payload.sub,
    email: String(payload.email ?? ""),
    tokenType,
    jti: typeof payload.jti === "string" ? payload.jti : null,
    teamId: typeof payload.team_id === "string" ? payload.team_id : null,
  };
}

/** Bearer-session guard; sets `userId` on the context. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const { authUserId } = await resolveSession(c);
  if (!authUserId) {
    return c.json({ error: "unauthorized", message: "Missing or invalid bearer token" }, 401);
  }
  c.set("userId", authUserId);
  c.set("authUserId", authUserId);
  await next();
});

/**
 * Optional session: sets `authUserId` (null when anonymous). Used by the
 * anonymised event endpoint — authenticated clients get personal attribution
 * and team validation; anonymous clients keep the privacy-first default.
 */
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  const { authUserId } = await resolveSession(c);
  c.set("authUserId", authUserId);
  await next();
});

async function resolveSession(c: Context<AppEnv>): Promise<{ authUserId: string | null }> {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) return { authUserId: null };
  try {
    const { userId, tokenType } = await verifyToken(token, c.env.JWT_SECRET);
    // Only long-lived session tokens are valid Bearer credentials — a
    // leaked magic link must not work directly as a session.
    if (tokenType !== "session") return { authUserId: null };
    return { authUserId: userId };
  } catch {
    return { authUserId: null };
  }
}

/** The app creator's emails (comma-separated ADMIN_EMAILS env), normalized. */
export function adminEmails(env: AppEnv["Bindings"]): Set<string> {
  const emails = new Set<string>();
  for (const raw of (env.ADMIN_EMAILS ?? "").split(",")) {
    const email = raw.trim().toLowerCase();
    if (email) emails.add(email);
  }
  return emails;
}

export function isAdminEmail(email: string, env: AppEnv["Bindings"]): boolean {
  return adminEmails(env).has(email.trim().toLowerCase());
}

/**
 * App-creator guard: a valid session whose user is listed in ADMIN_EMAILS.
 * The admin identity is derived from the email — impersonated sessions (a
 * different user's email) can never pass this guard, so an admin acting as a
 * user cannot escalate back to admin endpoints through that session.
 */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const { authUserId } = await resolveSession(c);
  if (!authUserId) {
    return c.json({ error: "unauthorized", message: "Missing or invalid bearer token" }, 401);
  }
  const db = await getDb(c.env);
  const repos = createRepos(db);
  const user = await repos.users.getById(authUserId);
  if (!user || !isAdminEmail(user.email, c.env)) {
    return c.json({ error: "forbidden", message: "App creator access only" }, 403);
  }
  c.set("userId", authUserId);
  c.set("authUserId", authUserId);
  await next();
});
