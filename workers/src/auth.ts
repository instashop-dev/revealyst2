import { createMiddleware } from "hono/factory";
import { SignJWT, jwtVerify } from "jose";
import type { AppEnv } from "./env.js";

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
): Promise<MagicToken> {
  const jti = crypto.randomUUID();
  const token = await new SignJWT({ email, token_type: "magic" })
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
  };
}

/** Bearer-session guard; sets `userId` on the context. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    return c.json({ error: "unauthorized", message: "Missing bearer token" }, 401);
  }
  try {
    const { userId, tokenType } = await verifyToken(token, c.env.JWT_SECRET);
    // Only long-lived session tokens are valid Bearer credentials — a
    // leaked magic link must not work directly as a session.
    if (tokenType !== "session") {
      return c.json({ error: "invalid_token", message: "Token is invalid or expired" }, 401);
    }
    c.set("userId", userId);
    await next();
  } catch {
    return c.json({ error: "invalid_token", message: "Token is invalid or expired" }, 401);
  }
});
