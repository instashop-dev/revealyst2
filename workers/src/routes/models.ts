import { Hono } from "hono";
import type { AppEnv } from "../env.js";

/**
 * GET /models/* — serve the ONNX prompt-scorer artifacts from R2 (spec §5.2).
 *
 * The extension loads the model at runtime (Transformers.js + head.json) from
 * MODEL_BASE_URL; this route lets it fetch the files over HTTPS from the API
 * worker without needing a public bucket URL (r2.dev/custom domain). Files are
 * public by design — the scorer is a rule distillation with no sensitive data.
 */
export const modelsRoutes = new Hono<AppEnv>();

const EXT_CONTENT_TYPES: Record<string, string> = {
  ".onnx": "application/octet-stream",
  ".json": "application/json",
  ".txt": "text/plain",
};

modelsRoutes.get("/models/*", async (c) => {
  let key = c.req.path.replace(/^\/models\//, "");
  // Transformers.js resolves remote models as <remoteHost>/<modelId>/resolve/
  // <revision>/<file> — drop the HF-style /resolve/<rev> segment so both the
  // library's fetch and direct URLs map onto the R2 keys.
  key = key.replace(/\/resolve\/[^/]+/, "");
  if (!key || key.includes("..")) {
    return c.json({ error: "bad_request", message: "Invalid model artifact path" }, 400);
  }
  const obj = await c.env.MODELS?.get(key);
  if (!obj) {
    return c.json({ error: "not_found", message: "Model artifact not found" }, 404);
  }
  const ext = key.slice(key.lastIndexOf("."));
  const headers = new Headers();
  headers.set(
    "Content-Type",
    obj.httpMetadata?.contentType ?? EXT_CONTENT_TYPES[ext] ?? "application/octet-stream",
  );
  headers.set("Cache-Control", "public, max-age=3600, immutable");
  headers.set("Access-Control-Allow-Origin", "*");
  // obj.body is a workers-types ReadableStream; Response expects the DOM
  // type — structurally identical at runtime, so cast.
  return new Response(obj.body as unknown as BodyInit, { headers });
});
