import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { authRoutes } from "./routes/auth.js";
import { suggestionRoutes } from "./routes/suggestion.js";
import { eventsRoutes } from "./routes/events.js";
import { libraryRoutes } from "./routes/library.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { requestLogger } from "./logger.js";
import type { AppEnv } from "./env.js";

const app = new OpenAPIHono<AppEnv>();

app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));
app.use("*", requestLogger);

app.get("/api/health", (c) =>
  c.json({ status: "ok", service: "revealyst-workers", time: new Date().toISOString() }, 200),
);

app.route("/", authRoutes);
app.route("/", suggestionRoutes);
app.route("/", eventsRoutes);
app.route("/", libraryRoutes);
app.route("/", dashboardRoutes);
app.route("/", feedbackRoutes);

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
