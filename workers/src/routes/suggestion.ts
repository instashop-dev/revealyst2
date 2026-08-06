import { createRoute, z } from "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRateLimiter, rateLimit } from "../rate-limit.js";
import { getSuggestions } from "../suggestions.js";
import type { AppEnv } from "../env.js";

const suggestionRequest = z.object({
  prompt_hash: z.string().max(128).optional(),
  flags: z.array(z.string().min(1).max(100)).max(10).optional(),
  score_breakdown: z.record(z.string().max(32), z.number()).optional(),
  user_id: z.string().max(128).optional(),
});
const suggestionSchema = z.object({
  id: z.string(),
  type: z.string(),
  text: z.string(),
  preview: z.string(),
  action: z.enum(["prepend", "append", "insert"]),
});
const errorResponse = z.object({ error: z.string(), message: z.string() });

const suggestionLimiter = rateLimit(createRateLimiter(30, 60_000), 30);

const route = createRoute({
  method: "post",
  path: "/api/suggestion",
  middleware: [suggestionLimiter],
  request: { body: { content: { "application/json": { schema: suggestionRequest } } } },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            suggestions: z.array(suggestionSchema),
            source: z.enum(["vectorize+llm", "static"]),
          }),
        },
      },
      description: "Suggestions for the given deficiencies",
    },
    400: { content: { "application/json": { schema: errorResponse } }, description: "Bad request" },
    429: {
      content: { "application/json": { schema: errorResponse } },
      description: "Rate limited",
    },
  },
});

export const suggestionRoutes = new OpenAPIHono<AppEnv>();

suggestionRoutes.openapi(route, async (c) => {
  const { flags, score_breakdown: breakdown } = c.req.valid("json");
  let deficiencies = flags ?? [];
  if (deficiencies.length === 0 && breakdown) {
    // Infer deficiencies from the lowest-scoring dimensions (spec §5.3:
    // trigger when score < 70 or specific flags present).
    const dimToFlag: Record<string, string> = {
      specificity: "low_specificity",
      context: "vague_context",
      role_clarity: "missing_role",
      output_format: "missing_output_format",
      examples_included: "no_examples",
    };
    const thresholds: Record<string, number> = {
      specificity: 60,
      context: 55,
      role_clarity: 50,
      output_format: 50,
      examples_included: 50,
    };
    deficiencies = Object.entries(breakdown)
      .filter(([dim, value]) => (thresholds[dim] ?? 0) > value)
      .map(([dim]) => dimToFlag[dim] ?? dim);
  }
  const result = await getSuggestions(deficiencies, c.env);
  return c.json(result, 200);
});
