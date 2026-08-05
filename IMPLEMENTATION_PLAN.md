# Revealyst — Implementation Plan & Status

> Living document. Updated 2026-08-05. Reflects the state of `main` after the
> Cloudflare Hyperdrive DB fix (`22d092c6…` / `revealyst-pooler`) and the merged
> web dashboard (PR #4, `ef141b2`).

## Project goal

Turn every prompt into a step forward: a Chrome extension + web dashboard that
scores LLM prompts in real time (PQS — Prompt Quality Score), gives one-click
suggestions, tracks skill growth, and gives team managers a privacy-first
dashboard. Full spec:
[`.reasonix/attachments/clipboard-20260805-151053.039642-000001.md`](.reasonix/attachments/clipboard-20260805-151053.039642-000001.md).

## Architecture

| Layer | Where | Stack |
| --- | --- | --- |
| Scoring engine | `packages/scoring` | Pure TS, rule-based + ONNX adapter w/ fallback |
| Chrome extension | `extension/` | MV3, Vite/CRXJS, React sidebar (300px, shadow DOM) |
| Web dashboard | `web/` | React + Vite, Cloudflare Pages |
| API | `workers/` | Hono (zod-openapi), Cloudflare Workers |
| Database | `db/` | Supabase Postgres (pooler) via Cloudflare **Hyperdrive** |
| Search | `vectorize/` | Cloudflare Vectorize (~5,000 seeded patterns) |
| ML assets | `ml/` | ONNX export notes, model registry |

## Phase status

| Phase | Status | Notes |
| --- | --- | --- |
| 1. Foundation & CI | ✅ Done | Monorepo, configs, CI + deploy workflows, docs, secrets bootstrap |
| 2. Scoring engine | ✅ Done | 5-dimension scorer, flags, color bands, ONNX adapter, tests + <200ms bench |
| 3. Backend & data | ✅ Done | Migrations (6 tables), Hono API, Vectorize seed, live deploy, **Hyperdrive DB round-trip verified** |
| 4. Chrome extension | ✅ Done | Sidebar UI, live scoring, suggestion apply, e2e, packaged `.zip` |
| 5. Web dashboard | 🟡 ~Done | All pages built + merged + deployed; final live verification pending |
| 6. Production readiness | ⬜ Pending | E2E integration, security review, observability, docs, v0.1.0 |

## What is done (verified on `main`)

### Phase 1 — Foundation & CI
- npm workspaces monorepo: `packages/scoring`, `extension/`, `web/`, `workers/`, `db/`, `vectorize/`, `ml/`
- Shared TS / ESLint / Prettier configs; workspace scripts (`typecheck`, `lint`, `test`, `build`, `format`)
- GitHub Actions: `ci.yml` (all gates) + `deploy.yml` (Workers, Pages, RDS, Vectorize) gated on secret presence
- README, `.gitignore`, `.editorconfig`, `.dev.vars.example`, `SECRETS.md`

### Phase 2 — Scoring engine
- `ScoreModel`: 5 dimensions, flags, color bands, truncation
- `ScoringAdapter` interface; `RuleScoringEngine` + `OnnxScoringAdapter` with load-or-fallback
- Unit tests (vague, role-rich, format-missing, long, PII) + <200ms benchmark — green

### Phase 3 — Backend & data
- `db/migrations/001_init.sql`: users, teams, team_members, prompt_events, library_prompts (+ 6th) + indexes
- Migration runner (`db/src/run-migrations.ts`); pg data layer tested with pg-mem (5/5)
- Hono API (`workers/src/routes/*`): `/api/auth/magic`, `/api/suggestion`, `/api/event`, `/api/library`, `/api/team/dashboard` + rate limiting + OpenAPI (`/api/docs`)
- Vectorize namespace `prompt-patterns` seeded with ~5,000 patterns (embeddings via OpenAI)
- **Live database**: Supabase pooler (`aws-0-us-east-1.pooler.supabase.com:6543`) migrated (`001_init.sql` applied)
- **Worker→DB connectivity**: fixed via Cloudflare Hyperdrive config `revealyst-pooler`
  (`22d092c611a54d648a45d3565bdce80a`); `getDb()` prefers `HYPERDRIVE.connectionString`
  and falls back to `DATABASE_URL`; live round-trip verified:
  `POST /api/auth/magic` → 200 `{"message":"link sent"}` in ~1s (was a 45s hang)
- Worker secrets set live: `DATABASE_URL`, `JWT_SECRET`, `OPENAI_API_KEY`, `LIBRARY_ENC_KEY`

### Phase 4 — Chrome extension
- MV3, Vite/CRXJS, React + TS + Tailwind sidebar (300px, shadow DOM)
- Resilient DOM detection for ChatGPT / Claude / Gemini; live scoring from `packages/scoring`
- One-click suggestion apply (prepend/append/insert) + fallback notices
- Thumbs up/down, save-to-library, pause, settings, onboarding tutorial, service-worker API client
- Playwright e2e against mock LLM pages + packaged `.zip` artifact

### Phase 5 — Web dashboard (mostly done)
- Magic-link auth pages (`LoginPage`, `VerifyPage`), app shell + routing
- Personal pages: Progress (trend + radar), Prompt History, Achievements, Settings
- Team Manager dashboard + shared Library pages
- Component/unit tests: **9/9 green** (`web/test/`: api, appshell, charts, smoke)
- Cloudflare Pages project `revealyst-web` created + deployed (deploy job green in every run)
- **Remaining (small):** final live smoke on the Pages URL + confirm auth round-trip

### Cross-cutting (verified)
- Full repo gates green: `typecheck`, `lint`, `format:check`, `test` (**84 tests total pass**)
- Deploy pipeline green end-to-end (latest: run `31033095452` — gate, vectorize, pages, workers, rds)

## What remains

### Phase 5 — close out
- [ ] Live smoke test of `https://revealyst.pages.dev` (login → magic link → dashboard)
- [ ] Confirm Pages auth round-trip against the live Worker/Hyperdrive DB
- [ ] Mark phase 5 complete in the session plan

### Phase 6 — Production readiness (not started)
- [ ] End-to-end integration suite + edge-case audit against spec §7
- [ ] Security review + fixes; observability/logging wired
- [ ] Architecture + runbook + ML notes + license docs
- [ ] Final CI green on `main`; live smoke tests; `v0.1.0` release; branch cleanup sweep

### Known tech debt / cleanup
- [ ] Delete stale Hyperdrive config `revealyst-neon` (`1f3ab3aa…`, created 2026-07-04, never used)
- [ ] `docs/runbook.md` referenced by `workers/wrangler.toml` comment does not exist yet
- [ ] CI Node-20 deprecation warning (`actions/checkout@v4`, `actions/setup-node@v4`) — bump to Node-24-compatible action versions

## How to verify

```bash
npm ci && npm run typecheck && npm run lint && npm run format:check && npm run test
curl -s https://revealyst-workers.thapi.workers.dev/api/health
curl -s -X POST https://revealyst-workers.thapi.workers.dev/api/auth/magic   -H 'Content-Type: application/json' -d '{"email":"you@example.com"}'   # → {"message":"link sent"}
```

## Deploy model

Merges to `main` trigger `.github/workflows/deploy.yml`: Workers API → Pages →
Vectorize → DB migrations + worker secrets. Secrets are gated via the `gate`
job; `DATABASE_URL` is user-provisioned (Supabase pooler) and proxied through
Hyperdrive in the Worker.
