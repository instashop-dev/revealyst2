# Revealyst — ML Notes

> Assets live in `ml/` (corpus generator, training scripts, model registry) and
> `vectorize/` (embedding pipeline).

## Current production pipeline (no training required)

The v0.1 suggestion pipeline is **embedding + retrieval + LLM**, not a
trained model:

1. **Embeddings**: OpenAI `text-embedding-3-small` (1536 dims).
2. **Vectorize namespace** `prompt-patterns` (metric `cosine`, dims 1536),
   seeded with ~5,000 hand-authored prompt-improvement patterns via
   `vectorize/src/seed.ts` (patterns in `vectorize/src/templates.ts`,
   generator in `generate.ts`).
3. **Suggestion generation**: `gpt-4o-mini` (temperature 0.4, JSON mode),
   constrained by a strict system prompt + retrieved patterns.
4. **Scoring**: rule heuristics in `packages/scoring` (deterministic,
   synchronous, <200 ms) **or** the local ONNX scorer (see below), with
   automatic fallback to rules (spec §5.2/§7).

## ONNX prompt-scorer (spec §5.2 — shipped as prompt-scorer-v1)

`ml/models/prompt-scorer-v1/` holds the trained artifact:

- `model_quantized.onnx` — int8 dynamic-quantized encoder (feature-extraction
  task), loaded by Transformers.js in the extension with `quantized: true`.
- `model.onnx` — fp32 encoder (gitignored; regenerate with `train.py`).
- `head.json` — the regression head: `sigmoid(W·mean_pool(hidden) + b)` →
  6 values `[overall, specificity, context, role_clarity, output_format,
examples_included]` (normalized 0..1, scaled to 0..100 by the adapter).
- `config.json`, `tokenizer.json`, … — preprocessing files for Transformers.js.
- `README.md` — provenance: training data, eval MAE, latency, sizes.

### How it is trained (rule distillation)

No human-labeled dataset exists yet, so the model is a **distillation of the
rule engine** — it reproduces rule behavior fully on-device. Swap the training
data for human labels (beta usage) and retrain when they exist.

1. `ml/src/generate-corpus.ts` (npm run generate:corpus -w ml) — deterministic
   seeded generator producing 6000 train / 1500 eval synthetic prompts
   (templates, assembled feature blocks, degraded variants, edge cases:
   empty/tiny/>4000-token truncated), labeled by `RuleScoringEngine` →
   `ml/data/{corpus,eval}.jsonl` (gitignored, reproducible).
2. `ml/python/train.py` — fine-tunes `sentence-transformers/all-MiniLM-L6-v2`
   (masked mean pooling + 6-output linear head) as a regression (MSE, 0..1
   targets), then:
   - saves the fine-tuned backbone + writes `head.json` (the linear head) for
     the JS adapter;
   - `ml/python/export_onnx.py` exports the backbone as a feature-extraction
     ONNX encoder (`torch.onnx.export`, opset 14), int8 dynamic quantization
     (onnxruntime) → `onnx/model_quantized.onnx`;
   - `ml/python/eval.py` verifies the int8 encoder + head against rule labels
     (MAE per dim, correlation, latency) and the provenance `README.md`
     records the numbers.
3. Hosting — `ml/scripts/upload.mjs` (also a `models` deploy job) uploads the
   artifact to the R2 bucket `revealyst-models`; the API worker serves it via
   `GET /models/*`, and the extension fetches it through `MODEL_BASE_URL`
   (`extension/src/lib/model-config.ts`, worker URL — already configured).
   See `docs/runbook.md` → "ONNX prompt-scorer model".

### Adapter

`packages/scoring/src/onnx-adapter.ts` (`OnnxScoringAdapter`) runs the
pipeline with `task: "feature-extraction"`, mean-pools the embeddings, and
applies `head.json` in JS. It falls back to the rule engine whenever the
model/head cannot be loaded or inference fails (spec §7), and the sidebar
shows a small "local model unavailable" note. The `text-classification`
contract from the original design is preserved for compatibility.

## Retraining / reseeding

- **Scorer**: edit the corpus generator or swap in human labels, then
  `ml/.venv/Scripts/python ml/python/train.py --epochs 6` (fine-tunes the
  encoder + head, writes `head.json`), `ml/.venv/Scripts/python
ml/python/export_onnx.py` (re-exports the int8 encoder), and
  `ml/.venv/Scripts/python ml/python/eval.py` (verifies the int8 + head
  against rule labels); run `node ml/scripts/verify-node.mjs` for the real
  adapter path; commit the new int8 artifact + provenance; the `models`
  deploy job uploads it.
- **Patterns**: edit `vectorize/src/templates.ts` (or extend `generate.ts`)
  and re-run `npm run seed -w vectorize` (uses `OPENAI_API_KEY` +
  `CLOUDFLARE_*`).
- **Embedding model change**: recreate the namespace
  (`npx wrangler vectorize create prompt-patterns --dimensions=<N> --metric=cosine`)
  and re-seed; keep `EMBEDDING_MODEL` in `workers/src/suggestions.ts` in sync.

## Privacy notes

- Prompt text is never stored or sent to the model pipeline — only scores,
  flags and `prompt_hash` leave the device; the suggestion pipeline embeds a
  _deficiency description_, not the prompt.
- The ONNX scorer runs entirely in the extension: the prompt is scored
  locally and only its hash is transmitted.
- Vectorize stores only pattern metadata (our own authored content).
