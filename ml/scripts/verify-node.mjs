#!/usr/bin/env node
/**
 * End-to-end verification of prompt-scorer-v1 through the REAL adapter path
 * (the same code the extension runs): Transformers.js feature-extraction
 * pipeline + head.json + OnnxScoringAdapter, scored against the rule-labeled
 * eval split.
 *
 * Run AFTER ml/python/train.py (needs ml/models/prompt-scorer-v1/):
 *   node ml/scripts/verify-node.mjs [--limit 200]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OnnxScoringAdapter } from "@revealyst/scoring";
import { env, pipeline as transformersPipeline } from "@xenova/transformers";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT = join(ROOT, "ml", "models", "prompt-scorer-v1");
// Verify against the local artifact only: no remote fetch, and resolve the
// model id relative to the repo root (transformers.js joins it onto
// env.localModelPath).
env.allowRemoteModels = false;
env.localModelPath = "./";
const LOCAL_MODEL_ID = "ml/models/prompt-scorer-v1";
const EVAL = join(ROOT, "ml", "data", "eval.jsonl");

const li = process.argv.indexOf("--limit");
const limitRaw = li !== -1 ? Number(process.argv[li + 1]) : 200;
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200;
const rows = readFileSync(EVAL, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .slice(0, limit);

const head = JSON.parse(readFileSync(join(ARTIFACT, "head.json"), "utf-8"));
const load = transformersPipeline;

const adapter = new OnnxScoringAdapter({
  modelId: LOCAL_MODEL_ID, // local dir: Transformers.js resolves files from here
  task: "feature-extraction",
  quantized: true,
  head,
  pipelineFactory: async (task, modelId, options) => load(task, modelId, options),
});

const DIMS = [
  "overall",
  "specificity",
  "context",
  "role_clarity",
  "output_format",
  "examples_included",
];
let maeSum = 0;
let overallMae = 0;
const t0 = Date.now();
let processed = 0;
for (const row of rows) {
  const result = await adapter.score(row.prompt);
  if (result.meta.engine !== "onnx") {
    console.error(`FALLBACK on "${row.prompt.slice(0, 60)}": ${result.meta.modelError ?? "?"}`);
    process.exitCode = 1;
    break;
  }
  const truth = [row.score, ...DIMS.slice(1).map((d) => row.breakdown[d])];
  const pred = [result.score, ...DIMS.slice(1).map((d) => result.breakdown[d])];
  maeSum += pred.reduce((s, p, i) => s + Math.abs(p - truth[i]), 0) / DIMS.length;
  overallMae += Math.abs(pred[0] - truth[0]);
  processed += 1;
}
const ms = Date.now() - t0;
if (processed === 0) {
  console.error("verify failed: the model path never produced an onnx result.");
  process.exit(1);
}
console.log(
  `rows: ${processed}/${rows.length} | engine: onnx | total ${ms}ms (${(ms / processed).toFixed(1)}ms/prompt)`,
);
console.log(
  `MAE all dims: ${(maeSum / processed).toFixed(2)} pts | MAE overall: ${(overallMae / processed).toFixed(2)} pts`,
);
