# Revealyst — ML Notes

> Assets live in `ml/` (ONNX export notes, model registry) and `vectorize/`
> (embedding pipeline). The `ml` package is currently a scaffold
> (`modelArtifactDir = "models"`); training artifacts land here as they are
> produced.

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
4. **Scoring**: deterministic rule heuristics in `packages/scoring` —
   synchronous, framework-free, <200 ms, fully unit-tested.

## ONNX model path (optional, spec §"scoring engine")

`packages/scoring/src/onnx-adapter.ts` implements a `ScoringAdapter` that can
run an ONNX prompt-scorer via `@xenova/transformers`. It is not shipped: no
artifact exists, so the factory falls back to the rule engine
(`createScoringEngine({ modelId })` → `engine.engineKind === "onnx"` →
`meta.engine === "rules"`).

To introduce a model:

1. Export an ONNX model (e.g. a small BERT-style regression on prompt →
   PQS dimensions) into `ml/models/` following the registry layout below.
2. Reference it from `createScoringEngine` config and add a benchmark in
   `packages/scoring/test/perf.test.ts` (keep <200 ms budget).
3. Keep `deriveFlags` as the single source of truth for flag thresholds so
   rules and ONNX flag identically.

### Model registry layout (planned)

```
ml/models/
  prompt-scorer-v1/
    model.onnx
    config.json        # dims, thresholds, license of training data
    README.md          # provenance: training data, eval PQS MAE, latency
```

Every artifact must record provenance (data license, eval metrics, latency)
before being committed to a public repo.

## Retraining / reseeding

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
- Vectorize stores only pattern metadata (our own authored content).
