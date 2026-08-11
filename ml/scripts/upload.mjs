#!/usr/bin/env node
/**
 * Upload the prompt-scorer-v1 artifact to Cloudflare R2 (bucket
 * `revealyst-models`, key prefix `prompt-scorer-v1/`).
 *
 * The extension fetches the model at runtime from the bucket's public URL
 * (Transformers.js). Rules fall back automatically while the model is
 * unreachable, so a placeholder URL is safe.
 *
 * One-time bucket setup (documented in docs/runbook.md):
 *   1. npx wrangler r2 bucket create revealyst-models
 *   2. Cloudflare dashboard → R2 → revealyst-models → Settings → Public access
 *      → "Allow access to this bucket via a custom domain or r2.dev" → copy
 *      the pub-<hash>.r2.dev URL.
 *   3. Put that URL in extension/src/lib/model-config.ts as MODEL_BASE_URL
 *      (and in the web Settings hint if it surfaces the value).
 *
 * Usage (requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env):
 *   node ml/scripts/upload.mjs
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT_DIR = join(ROOT, "ml", "models", "prompt-scorer-v1");
const BUCKET = "revealyst-models";
const PREFIX = "prompt-scorer-v1";

// Files uploaded to R2 (int8 model + tokenizer + config + head). The fp32
// model.onnx is intentionally excluded — the adapter loads the quantized file.
// The onnx/ prefix matches the layout Transformers.js expects for remote
// models: <base>/onnx/model_quantized.onnx.
const FILES = [
  "onnx/model_quantized.onnx",
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.txt",
  "special_tokens_map.json",
  "head.json",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[upload] missing ${name} — set it (see docs/runbook.md)`);
    process.exit(1);
  }
  return value;
}

function main() {
  requireEnv("CLOUDFLARE_API_TOKEN");
  requireEnv("CLOUDFLARE_ACCOUNT_ID");

  for (const file of FILES) {
    const local = join(ARTIFACT_DIR, file);
    if (!statSync(local, { throwIfNoEntry: false })) {
      console.warn(`[upload] missing ${local} — skipped`);
      continue;
    }
    const key = `${PREFIX}/${file}`;
    console.log(`[upload] putting ${key} (${(statSync(local).size / 1e6).toFixed(2)} MB)...`);
    execFileSync("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", local], {
      stdio: "inherit",
      cwd: ROOT,
    });
  }

  const remaining = FILES.filter((f) => statSync(join(ARTIFACT_DIR, f), { throwIfNoEntry: false }));
  console.log(
    `\n[upload] done — ${remaining.length}/${FILES.length} files in s3://${BUCKET}/${PREFIX}/`,
  );
  console.log(
    `[upload] public base URL: https://pub-<hash>.r2.dev/${PREFIX}  (see runbook, step 2)`,
  );
  console.log(
    `[upload] set extension MODEL_BASE_URL to that URL (extension/src/lib/model-config.ts).`,
  );
}

main();
