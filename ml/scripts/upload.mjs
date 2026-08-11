#!/usr/bin/env node
/**
 * Upload the prompt-scorer-v1 artifact to Cloudflare R2 (bucket
 * `revealyst-models`, key prefix `prompt-scorer-v1/`).
 *
 * The extension fetches the model at runtime from the API worker's
 * GET /models/* route (R2 binding → revealyst-models). Rules fall back
 * automatically while the model is unreachable (spec §7).
 *
 * wrangler `r2 object` commands default to the LOCAL simulator — `--remote`
 * is required to touch the real bucket (this burned the first upload: it
 * "succeeded" into the simulator and the bucket stayed empty).
 *
 * Usage (requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env, or
 * a wrangler login):
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
    execFileSync(
      "npx",
      ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", local, "--remote"],
      { stdio: "inherit", cwd: ROOT },
    );
  }

  const remaining = FILES.filter((f) => statSync(join(ARTIFACT_DIR, f), { throwIfNoEntry: false }));
  console.log(
    `\n[upload] done — ${remaining.length}/${FILES.length} files in s3://${BUCKET}/${PREFIX}/ (remote)`,
  );
  console.log(
    `[upload] served by the API worker at https://revealyst-workers.thapi.workers.dev/models/${PREFIX}`,
  );
}

main();
