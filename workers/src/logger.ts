import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env.js";

/**
 * Request logging for Workers Logs / the observability dashboard.
 *
 * PII-safe by construction:
 *  - logs only the URL pathname — never the query string (magic links in
 *    query params are working credentials);
 *  - no request/response bodies, no headers beyond cf-ray (correlation id);
 *  - health checks are skipped to keep the log stream readable.
 */
export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const start = Date.now();
  await next();
  const path = new URL(c.req.url).pathname;
  if (path === "/api/health") return;
  const ray = c.req.header("cf-ray") ?? "-";
  console.log(`[api] ${c.req.method} ${path} ${c.res.status} ${Date.now() - start}ms ray=${ray}`);
});
