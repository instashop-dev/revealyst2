# Revealyst — Implementation Plan & Status

> Living document. Updated 2026-08-07. Reflects the state of `main` after
> Phase 6 close-out (PRs #6–#16): everything in this plan is done and
> deployed, with live smoke + full-stack journey e2e green.

## Project goal

Turn every prompt into a step forward: a Chrome extension + web dashboard that
scores LLM prompts in real time (PQS — Prompt Quality Score), gives one-click
suggestions, tracks skill growth, and gives team managers a privacy-first
dashboard. Full spec:
[`.reasonix/attachments/clipboard-20260805-151053.039642-000001.md`](.reasonix/attachments/clipboard-20260805-151053.039642-000001.md).

## Architecture

See `docs/architecture.md` for the full model (components, data flows,
security model, key decisions).

| Layer            | Where              | Stack                                                              |
| ---------------- | ------------------ | ------------------------------------------------------------------ |
| Scoring engine   | `packages/scoring` | Pure TS, rule-based + ONNX adapter w/ fallback                     |
| Chrome extension | `extension/`       | MV3, Vite/CRXJS, React sidebar (300px, shadow DOM)                 |
| Web dashboard    | `web/`             | React + Vite, Cloudflare Pages (`revealyst-web.pages.dev`)         |
| API              | `workers/`         | Hono (zod-openapi), Cloudflare Workers                             |
| Database         | `db/`              | AWS RDS PostgreSQL via Cloudflare **Hyperdrive** (`revealyst-rds`) |
| Search           | `vectorize/`       | Cloudflare Vectorize (~5,000 seeded patterns)                      |
| ML assets        | `ml/`              | ONNX export notes, model registry                                  |
| Docs             | `docs/`            | architecture.md, runbook.md, ml-notes.md                           |

## Phase status

| Phase                   | Status  | Notes                                                                                                                             |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1. Foundation & CI      | ✅ Done | Monorepo, configs, CI + deploy workflows, docs, secrets bootstrap                                                                 |
| 2. Scoring engine       | ✅ Done | 5-dimension scorer, flags, color bands, ONNX adapter, tests + <200ms bench                                                        |
| 3. Backend & data       | ✅ Done | Migrations, Hono API, Vectorize seed, live deploy, Hyperdrive DB round-trip verified                                              |
| 4. Chrome extension     | ✅ Done | Sidebar UI, live scoring, suggestion apply, e2e, packaged `.zip`                                                                  |
| 5. Web dashboard        | ✅ Done | All pages built + merged + deployed; **SES magic-link email live**; auth round-trip verified                                      |
| 6. Production readiness | ✅ Done | E2E smoke (live) + full-stack journey (real RDS/Vectorize/OpenAI), security review, observability, docs, tech debt, v0.1.0 tagged |

## What is done

### Phase 1 — Foundation & CI

- npm workspaces monorepo: `packages/scoring`, `extension/`, `web/`, `workers/`, `db/`, `vectorize/`, `ml/`
- Shared TS / ESLint / Prettier configs; workspace scripts (`typecheck`, `lint`, `test`, `build`, `format`)
- GitHub Actions: `ci.yml` (all gates) + `deploy.yml` (Workers, Pages, RDS, Vectorize, smoke, journey) gated on secret presence

### Phase 2 — Scoring engine

- `ScoreModel`: 5 dimensions, flags, color bands, truncation
- `ScoringAdapter` interface; `RuleScoringEngine` + `OnnxScoringAdapter` with load-or-fallback
- Unit tests (vague, role-rich, format-missing, long, too-short, determinism) + <200ms benchmark — green

### Phase 3 — Backend & data

- `db/migrations/001_init.sql` + `002_magic_links.sql`: users, teams, team_members,
  prompt_events, library_prompts, suggestions_feedback, magic_link_tokens + indexes
- Migration runner (`db/src/run-migrations.ts`); pg data layer tested with pg-mem (5/5)
- Hono API (`workers/src/routes/*`): `/api/auth/magic`, `/api/auth/verify`, `/api/auth/me`,
  `/api/suggestion`, `/api/event`, `/api/library`, `/api/team/dashboard`, `/api/feedback`
  - rate limiting + OpenAPI (`/api/docs`)
- Vectorize namespace `prompt-patterns` seeded with ~5,000 patterns (embeddings via OpenAI)
- **Live database**: Supabase pooler migrated; Worker→DB via Hyperdrive `revealyst-pooler`
  with `DATABASE_URL` fallback; live round-trip verified
- **DB pool fix**: `getDb` now caches one postgres.js pool per connection string
  (module-global) — the previous WeakMap-keyed-on-env cache spawned a pool per request
  and exhausted the upstream connection limit (intermittent 500s/hangs on auth)
- Worker secrets set live: `DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY`, `LIBRARY_ENC_KEY`,
  `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`

### Phase 4 — Chrome extension

- MV3, Vite/CRXJS, React + TS + Tailwind sidebar (300px, shadow DOM)
- Resilient DOM detection for ChatGPT / Claude / Gemini; live scoring from `packages/scoring`
- One-click suggestion apply (prepend/append/insert) + fallback notices
- Thumbs up/down, save-to-library, pause, settings, onboarding tutorial, service-worker API client
- Playwright e2e against mock LLM pages + packaged `.zip` artifact

### Phase 5 — Web dashboard (done)

- Magic-link auth pages (`LoginPage`, `VerifyPage`), app shell + routing
- Personal pages: Progress (trend + radar), Prompt History, Achievements, Settings
- Team Manager dashboard + shared Library pages
- Component/unit tests green (`web/test/`)
- Cloudflare Pages project `revealyst-web` live at `https://revealyst-web.pages.dev`
- **APP_URL config bug fixed** — was `revealyst.pages.dev` (NXDOMAIN); now the real URL,
  so magic links resolve to the dashboard (SPA fallback for `/auth/verify` verified 200)
- **AWS SES magic-link email** — zero-dependency SigV4 sender (`workers/src/email.ts`),
  verified against the official AWS SigV4 test vector; sender `Revealyst <noreply@e.revealyst.com>`
  on the `e.revealyst.com` subdomain; deploy pipeline sets SES Worker secrets
- **Auth hardening** (from the security review): `token_type` separation (magic vs session),
  jti single-use magic links (atomic consume, replay-proof), verify rate limiter,
  email normalization, per-recipient cooldown, uniform 200 anti-oracle responses,
  PII-safe logging, HTML-escaped email body

### Phase 6 — Production readiness (~done)

- **E2E integration suite** — `e2e/api-smoke.mjs` (health, OpenAPI, auth shape, magic link,
  suggestion engine, session-auth boundaries, SPA fallback) runs as the `smoke` job after every deploy.
  Its first live run caught the getDb pool-leak bug above.
- **Full-stack journey e2e** — `e2e/journey.mjs` runs the complete authenticated journey
  (magic-link auth → events → history/stats → feedback → suggestion → team lifecycle → shared library)
  against a local `wrangler dev` worker wired to the **real** RDS/Vectorize/OpenAI (DEV_MODE magic
  links), then removes its own test rows. Runs as the `journey` deploy job. First runs caught three
  real Postgres-integration bugs that pg-mem masked: TEXT[] params ("malformed array literal"),
  JSONB columns returned as strings (`fetch_types: false` — identifiable mode could never activate),
  and jsonb writes via `JSON.stringify` storing jsonb _strings_.
- **Edge-case audit vs spec §7** — fixed `describeDeficiency` single-flag bug (degenerate
  embedding query text); hardened `/api/suggestion` + `/api/event` input schemas
  (bounded flag strings, hash/key caps)
- **Security review** — 4 passes, final verdict **not blocking**; blocking finding
  (inline user-deletion cleanup) caught and reverted; see hardening list in Phase 5
- **Observability** — `[observability] enabled`; PII-safe request logger
  (`[api] METHOD path STATUS ms ray=…`); enriched error logs; runbook monitoring guide
- **Docs** — `docs/architecture.md`, `docs/runbook.md`, `docs/ml-notes.md`
  (LICENSE intentionally omitted — owner decision)
- **Tech debt** — CI actions bumped to Node-24-compatible v5 (`checkout`, `setup-node`,
  `upload-artifact`); stale Hyperdrive config `revealyst-neon` auto-deleted in deploy;
  runbook references resolved

### Cross-cutting (verified)

- Full repo gates green: `typecheck`, `lint`, `format:check`, `test` (**~120 tests:
  workers 45, scoring 25, db 5, web 9, extension ~25, ml 1**), `build`
- Live: `/api/health` 200; dashboard root 200; `/auth/verify` SPA fallback 200;
  `POST /api/auth/magic` 200 (~1s) for existing users

## What remains

### Phase 6 — close out (this PR)

- [x] CI green on the PR; merged to `main`
- [x] Deploy green end-to-end incl. the `smoke` + `journey` jobs; post-deploy live smoke PASS
- [x] `v0.1.0` tag + GitHub release; branch cleanup sweep (done — only `main` remains)
- [x] **Magic-link email delivery verified** — SES IAM policy now allows `ses:SendEmail`;
      a live SigV4 probe against `email.us-east-1.amazonaws.com` returned `200` + MessageId
      (identity/subdomain `e.revealyst.com` configured, keys live on the Worker)

### Post-v0.1 hardening backlog (tracked in runbook)

- [ ] Cloudflare WAF / rate-limiting rules in front of `/api/auth/magic` (per-isolate
      limiter is bypassable by distributed attackers)
- [ ] Grant SES production access (exit sandbox) so arbitrary recipients can log in
- [ ] Scheduled unverified-user pruning job (careful: no sessions table; FK-safe)
- [ ] Optional: functional unique index on `lower(email)` to structurally dedupe users
- [ ] Optional: DB-backed session revocation for server-side sign-out

## How to verify

```bash
npm ci && npm run typecheck && npm run lint && npm run format:check && npm run test && npm run build
node e2e/api-smoke.mjs                                          # live smoke vs deployed endpoints
# full-stack journey (local worker + real RDS/Vectorize/OpenAI):
#   export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL?sslmode=require"
#   (cd workers && npx wrangler dev --port 8788 --ip 127.0.0.1)  # with DEV_MODE=true in .dev.vars
#   DATABASE_URL=$DATABASE_URL node e2e/journey.mjs
curl -s https://revealyst-workers.thapi.workers.dev/api/health  # {"status":"ok",...}
curl -s -X POST https://revealyst-workers.thapi.workers.dev/api/auth/magic \
  -H 'Content-Type: application/json' -d '{"email":"you@example.com"}'  # → {"message":"link sent"} (uniform 200; delivery is confirmed in SES console)
```

## Deploy model

Merges to `main` trigger `.github/workflows/deploy.yml`: `gate` → `vectorize` →
`workers` (deploy + secrets incl. SES) → `rds` (migrations + Hyperdrive ensure +
stale-config cleanup) → `pages` → `smoke` → `journey`. Secrets are gated via the `gate` job;
`DATABASE_URL` is user-provisioned (AWS RDS) and proxied through
Hyperdrive (`revealyst-rds`) in the Worker. See `docs/runbook.md` for operations.
