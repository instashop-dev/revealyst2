import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env.js";

/**
 * Minimal in-memory fixed-window rate limiter. Per-isolate only — Cloudflare
 *'s built-in rate limiting is the production hardening layer (see runbook).
 */
export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return function check(ip: string): { ok: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return { ok: true, remaining: limit - 1, resetAt: now + windowMs };
    }
    if (entry.count >= limit) {
      return { ok: false, remaining: 0, resetAt: entry.resetAt };
    }
    entry.count += 1;
    return { ok: true, remaining: limit - entry.count, resetAt: entry.resetAt };
  };
}

export function rateLimit(limiter: ReturnType<typeof createRateLimiter>, limit: number) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.env.RATE_LIMIT_DISABLED === "true") {
      await next();
      return;
    }
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const result = limiter(ip);
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.ok) {
      return c.json({ error: "rate_limited", message: "Too many requests, slow down." }, 429);
    }
    await next();
  });
}
