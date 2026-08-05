import { createMiddleware } from "hono/factory";
import { SignJWT, jwtVerify } from "jose";
import type { AppEnv } from "./env.js";

const ISSUER = "revealyst";
const AUDIENCE = "revealyst-app";
const encoder = new TextEncoder();

export interface AuthPayload {
  userId: string;
  email: string;
}

async function sign(
  payload: { email: string },
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

/** Short-lived magic-link token (15 min). */
export function signMagicToken(userId: string, email: string, secret: string): Promise<string> {
  return sign({ email }, userId, secret, "15m");
}

/** Session token (7 days). */
export function signSessionToken(userId: string, email: string, secret: string): Promise<string> {
  return sign({ email }, userId, secret, "7d");
}

export async function verifyToken(token: string, secret: string): Promise<AuthPayload> {
  const { payload } = await jwtVerify(token, encoder.encode(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!payload.sub) throw new Error("missing subject");
  return { userId: payload.sub, email: String(payload.email ?? "") };
}

/** Bearer-session guard; sets `userId` on the context. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    return c.json({ error: "unauthorized", message: "Missing bearer token" }, 401);
  }
  try {
    const { userId } = await verifyToken(token, c.env.JWT_SECRET);
    c.set("userId", userId);
    await next();
  } catch {
    return c.json({ error: "invalid_token", message: "Token is invalid or expired" }, 401);
  }
});
