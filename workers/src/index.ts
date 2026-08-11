import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { authRoutes } from "./routes/auth.js";
import { suggestionRoutes } from "./routes/suggestion.js";
import { eventsRoutes } from "./routes/events.js";
import { libraryRoutes } from "./routes/library.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { teamRoutes } from "./routes/teams.js";
import { historyRoutes } from "./routes/history.js";
import { statsRoutes } from "./routes/stats.js";
import { adminRoutes } from "./routes/admin.js";
import { modelsRoutes } from "./routes/models.js";
import { accountRoutes } from "./routes/account.js";
import { requestLogger } from "./logger.js";
import { closeRequestDb, getDb } from "./db.js";
import type { AppEnv } from "./env.js";

const app = new OpenAPIHono<AppEnv>();

app.use(
  "/api/*",
  cors({ origin: "*", allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }),
);
app.use("*", requestLogger);
// Per-request DB lifecycle: the request's connection (created lazily by the
// route's getDb call) is closed after the response. Required — Cloudflare
// forbids socket I/O shared across requests.
app.use("/api/*", async (c, next) => {
  try {
    await next();
  } finally {
    await closeRequestDb(c.env);
  }
});

app.get("/api/health", async (c) => {
  const body: Record<string, unknown> = {
    status: "ok",
    service: "revealyst-workers",
    time: new Date().toISOString(),
  };
  // Deep check: /api/health?db=1 runs a DB round-trip (SELECT 1) so ops can
  // verify the Hyperdrive→Postgres path from anywhere.
  // Deep check: /api/health?db=1 runs a DB round-trip (SELECT 1) so ops can
  // verify the Hyperdrive→Postgres path from anywhere.
  if (c.req.query("db") === "1") {
    try {
      const db = await getDb(c.env);
      await Promise.race([
        db.query("SELECT 1"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("db round-trip timed out (10s)")), 10_000),
        ),
      ]);
      body.db = "ok";
    } catch (err) {
      body.db = `error: ${(err as Error).message}`;
      body.status = "degraded";
      console.error("[api] deep health db check failed:", err);
    }
  }
  return c.json(body, 200);
});

app.route("/", authRoutes);
app.route("/", suggestionRoutes);
app.route("/", eventsRoutes);
app.route("/", libraryRoutes);
app.route("/", dashboardRoutes);
app.route("/", feedbackRoutes);
app.route("/", teamRoutes);
app.route("/", historyRoutes);
app.route("/", statsRoutes);
app.route("/", adminRoutes);
app.route("/", modelsRoutes);
app.route("/", accountRoutes);

// OpenAPI document (spec §6.4 contract) + minimal HTML docs page.
app.doc("/api/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "Revealyst API",
    version: "0.1.0",
    description: "Prompt coaching & team analytics API",
  },
});

app.get("/api/docs", (c) => {
  return c.html(`<!doctype html><html><head><title>Revealyst API</title></head>
<body><h1>Revealyst API</h1><p>OpenAPI spec at <a href="/api/openapi.json">/api/openapi.json</a></p></body></html>`);
});

app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));
app.onError((error, c) => {
  const ray = c.req.header("cf-ray") ?? "-";
  console.error(
    `[api] unhandled error on ${c.req.method} ${new URL(c.req.url).pathname} ray=${ray}:`,
    error,
  );
  return c.json({ error: "internal_error", message: "Something went wrong" }, 500);
});

export default app;
