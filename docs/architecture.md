# Revealyst — Architecture

> Companion to `IMPLEMENTATION_PLAN.md` and `docs/runbook.md`.

## System overview

Revealyst is a privacy-first prompt-coaching companion: a Chrome extension that
scores LLM prompts in real time, a web dashboard for personal progress and
team analytics, and a Cloudflare-hosted API + Postgres backend.

```
┌─────────────────────────────┐      ┌──────────────────────────────┐
│ Chrome extension (MV3)      │      │ Web dashboard (Cloudflare    │
│ React sidebar 300px         │      │ Pages, React + Vite)         │
│ scoring: packages/scoring   │      │ progress / history / team    │
│ suggestions: POST /suggestion│     │ library / settings           │
└──────────┬──────────────────┘      └──────────────┬───────────────┘
           │                                        │
           └──────────────┬─────────────────────────┘
                          ▼
              ┌────────────────────────┐
              │ Workers API (Hono)     │  revealyst-workers.thapi.workers.dev
              │ auth, suggestion,      │  [observability] enabled
              │ events, library,       │  request logger (PII-safe)
              │ dashboard, feedback    │
              └───────┬─────────┬──────┘
                      │         │
        Hyperdrive    │         │ Vectorize
        (AWS RDS,     │         │ (prompt-patterns, ~5,000 vectors)
        PostgreSQL)   ▼         ▼
        + migrations  ┌─────────────────────┐
        (db/)         │ OpenAI: embeddings  │
                      │ + gpt-4o-mini       │
                      └─────────────────────┘
```

## Components

| Layer            | Where              | Stack                                                                           |
| ---------------- | ------------------ | ------------------------------------------------------------------------------- |
| Scoring engine   | `packages/scoring` | Pure TS; rule-based + ONNX adapter with fallback; synchronous, <200 ms          |
| Chrome extension | `extension/`       | MV3, Vite/CRXJS, React + Tailwind sidebar (300px, shadow DOM)                   |
| Web dashboard    | `web/`             | React + Vite, Cloudflare Pages (`revealyst-web.pages.dev`)                      |
| API              | `workers/`         | Hono + zod-openapi on Cloudflare Workers                                        |
| Database         | `db/`              | AWS RDS PostgreSQL via Cloudflare **Hyperdrive** (`revealyst-rds`); postgres.js |
| Search           | `vectorize/`       | Cloudflare Vectorize `prompt-patterns` namespace + seed scripts                 |
| ML assets        | `ml/`              | ONNX export notes, model registry (see `docs/ml-notes.md`)                      |

## Data flows

### Prompt scoring (extension, offline)

Extension runs `packages/scoring` in-page: 5 dimensions (specificity, context,
role_clarity, output_format, examples_included) → 0–100 PQS + color band
(red 0–49, yellow 50–69, green 70–100) + canonical flags
(`low_specificity`, `vague_context`, `missing_role`, …). Only the score,
flags, and a `prompt_hash` leave the device — **raw prompt text never leaves
the extension** (PII-safe by design).

### Suggestions (server)

1. Extension posts `{ flags, prompt_hash }` → `/api/suggestion` (rate 30/min/IP).
2. Flags → deficiency sentence (`describeDeficiency`) → OpenAI embedding →
   Vectorize top-3 patterns → GPT-4o-mini → ≤3 one-click suggestions.
3. Any upstream failure: retry once, then deterministic static patterns, then
   generic tips (`source: "vectorize+llm" | "static"`).

### Auth (magic link)

1. `POST /api/auth/magic` — zod-validated, email normalized (trim/lowercase),
   user created lazily; 15-min JWT with `token_type: "magic"` + `jti`;
   jti recorded in `magic_link_tokens`; email sent via **AWS SES** (SigV4,
   zero-dependency WebCrypto signer). Responses are uniformly `200` — never
   reveals delivery/cooldown state (anti-oracle). Rate: 5/min/IP + 60 s
   per-recipient cooldown.
2. `POST /api/auth/verify` — accepts only `token_type: "magic"`, consumes the
   jti atomically (`DELETE … RETURNING`), issues a 7-day
   `token_type: "session"` JWT. Single-use, replay-proof across isolates.
3. `requireAuth` accepts only `token_type: "session"` — a leaked magic link
   cannot be used as a Bearer session.

### Events + team dashboard

`POST /api/event` stores anonymised rows (hash + anon id + score/breakdown —
never prompt text). Managers read `/api/team/dashboard` (authz: `isManager`).

## Security model

- **JWT (jose, HS256)**: issuer/audience pinned; `token_type` separates magic
  vs session; magic links 15 min, single-use via jti; sessions 7 days.
- **Rate limiting**: per-isolate in-memory (per-IP) — production hardening is
  Cloudflare-level rate limiting (see runbook).
- **Secrets**: never in code; Worker secrets (`wrangler secret put`), GitHub
  Actions secrets; `DATABASE_URL` proxied through Hyperdrive.
- **Logging**: PII-safe — pathnames only, no query strings/bodies; recipient
  addresses hashed in logs.
- **Library prompts**: AES-256-GCM encrypted at rest (`LIBRARY_ENC_KEY`).

## Key decisions

- **Zero-dependency SES** — SigV4 signing via WebCrypto avoids the AWS SDK in
  Workers; validated against the official AWS test vector.
- **Global DB pool** — `getDb` caches one postgres.js pool per connection
  string per isolate (keyed globally, _not_ on the per-request env object —
  the old WeakMap-on-env spawned a pool per request and exhausted the
  upstream connection limit).
- **Single-use magic links in Postgres** — cross-isolate replay-proof.
- **Uniform auth responses** — no user/delivery enumeration.
