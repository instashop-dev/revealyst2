# Revealyst — Implementation Plan & Status

> Living document. Updated 2026-08-07. Reflects the state of `main` after
> Phase 6 close-out (PRs #6–#19): everything in this plan is done and
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
- **Local dev fixed (PR #19)** — the full-stack journey failed on a fresh
  machine because miniflare's Hyperdrive emulation pipes _plaintext_ to RDS
  when the local connection string lacks `?sslmode=require` (RDS rejects it),
  and wrangler 4.x reads Cloudflare auth + the Hyperdrive local string from the
  **process env**, not `.dev.vars`. `npm run dev:local -w workers`
  (`workers/scripts/dev-local.mjs`) now exports those vars and runs the pinned
  wrangler (devDependency `^4.107.0`) — journey runs green locally and in CI.

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

### Team invites (§5.8, post-v0.1)

- **Tracked invites** — `team_invites` table (migration 005) records pending/revoked/accepted
  invites with role, inviter, and the live magic-link jti. One pending invite per team+email
  (re-inviting refreshes the same row).
- **API** — `POST /api/team/invite` accepts an optional `role` (`member`/`manager`) and returns
  `invite_id`; new `GET /api/team/invites`, `POST /api/team/invites/:id/revoke` (consumes the
  jti, killing the link), `POST /api/team/invites/:id/resend` (rotates to a fresh link). All
  manager-only. Verify marks the invite accepted and auto-joins the invitee with the invited role.
- **UI** — new `TeamInvites` component (invite form with role, pending list, re-send/revoke)
  on the Team dashboard ("Members & invites", manager view) and in Settings. Inviting an
  existing member returns a clear 400.

## Spec-gap audit (2026-08-07, PR #21)

A full spec-vs-code audit (spec §5–§7 as primary source) found and fixed:

| Gap                                                                                                                                                                                                                       | Spec                                                                                          | Fix                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension "Save to Library" always failed — hardcoded `team_id: ""`, no auth token, `/api/library` requires a session                                                                                                     | §5.1 star, §5.5 promote, §5.6 save                                                            | New extension Settings panel (⚙️): API token (copied from web Settings → "Connect the extension"), team picker (loads `/api/teams`), local history view; save sends `Authorization: Bearer` + real team id; actionable error messages          |
| Thumbs broken/incomplete — only 👍, not gated on LLM response, feedback used a fake `feedback:<ts>` hash rejected by the `/api/event` SHA-256 validator; suggestion acceptance never recorded (`accepted_count` always 0) | §5.1 "Thumbs up/down (visible after LLM response appears)", §5.6 `suggestions_feedback`       | 👍/👎 row gated on response detection (MutationObserver over the platform's `responseSelectors`, previously dead data); rating (-1/1) sent with the real prompt hash; Apply posts `/api/feedback {suggestion_id, was_accepted}` when connected |
| No personal prompt history in the extension (`STORAGE_KEYS.history` was dead code); §5.4 "prompt snippet" existed nowhere                                                                                                 | §5.1 "view personal prompt history", §5.4 history snippet                                     | Local history persisted in `chrome.storage.local` (dedupe consecutive scores, ratings, clear), viewable in the extension Settings panel — snippets stay device-only (privacy §5.7)                                                             |
| No client-side static fallback tips when the suggestion server is unreachable                                                                                                                                             | §7 "Retry once; if still failing, show a static generic tip from a client-side fallback list" | `CLIENT_TIPS` fallback list in the extension + single retry in the service-worker API client                                                                                                                                                   |
| Web Prompt History had no "rating"                                                                                                                                                                                        | §5.4 history list fields                                                                      | `prompt_events.rating SMALLINT` (migration 004), `/api/event` + `/api/history` carry it, History page shows 👍/👎/—                                                                                                                            |
| Library version history unreachable from the UI (only the API supported PATCH `prompt_text` → new version)                                                                                                                | §5.6 "each edit creates a new version, preserving original"                                   | Library edit form edits prompt text; manager notes/Team Standard carry onto the new version row                                                                                                                                                |
| "Your first week" mini-challenge badge missing                                                                                                                                                                            | §5.8                                                                                          | "First Week Challenge" badge (5 green prompts) in Achievements, judged on the 7-day stats window                                                                                                                                               |
| `/api/suggestion` request from the extension omitted `prompt_hash`                                                                                                                                                        | §6.4 critical fields                                                                          | Extension now sends it                                                                                                                                                                                                                         |

**Audit limitation (since closed):** at audit time the spec §5.2 client-side
DistilBERT/ONNX model was not wired into the extension — no trained artifact
existed (`docs/ml-notes.md`). That gap is now closed by the rule-distilled
`prompt-scorer-v1` below.

## Post-audit: ONNX prompt-scorer + north-star metrics (2026-08-10)

### ONNX prompt-scorer (spec §5.2 — closes the limitation above)

The local scorer now ships as a **rule distillation**: a trained int8 ONNX
model that reproduces the rule engine on-device until human-labeled beta data
exists.

- **Corpus** (`ml/src/generate-corpus.ts`, `npm run generate:corpus -w ml`):
  deterministic seeded generator → 6000 train / 1500 eval synthetic prompts
  (templates, assembled feature blocks, degraded variants, edge cases),
  labeled by `RuleScoringEngine` → `ml/data/{corpus,eval}.jsonl` (gitignored,
  reproducible with the same seed).
- **Training** (`ml/python/train.py`, CPU): fine-tunes
  `sentence-transformers/all-MiniLM-L6-v2` as a 6-output regression (MSE,
  targets `[overall, specificity, context, role_clarity, output_format,
examples_included]` normalized 0..1), then exports the encoder as
  feature-extraction ONNX (opset 14) + int8 dynamic quantization, writes the
  regression head to `head.json`, and verifies with onnxruntime.
- **Artifact** (`ml/models/prompt-scorer-v1/`): `model_quantized.onnx`
  (~23 MB int8), `head.json`, tokenizer files, provenance `README.md`
  (train data, eval MAE, latency, sizes). The fp32 `model.onnx` + checkpoints
  are gitignored. Eval (int8, eval split, 0-100 scale): mean MAE **2.92**,
  overall MAE **1.72**, Pearson r **0.996**, median latency **3.7 ms**
  (`ml/python/eval.py`); the real adapter path (Transformers.js +
  `OnnxScoringAdapter`, `ml/scripts/verify-node.mjs`) measures mean MAE
  **2.89**, overall **1.67**, 8.2 ms/prompt over 1500 prompts, zero
  fallbacks.
- **Hosting**: `models` deploy job + `ml/scripts/upload.mjs` upload the
  artifact to the R2 bucket `revealyst-models` (`--remote` — wrangler r2
  object commands default to the local simulator otherwise); the API worker
  serves it via `GET /models/*` (`workers/src/routes/models.ts`), and the
  extension loads it from `MODEL_BASE_URL` = the worker URL (already
  configured in `extension/src/lib/model-config.ts`). If the model cannot
  load, the extension falls back to rules (spec §7).
- **Adapter** (`packages/scoring/src/onnx-adapter.ts`): new
  `feature-extraction` + `head.json` path (mean-pooled embedding →
  `sigmoid(W·h + b)` → 6 dims), injected `pipelineFactory` for bundled
  extensions, and the original `text-classification` contract preserved.
  Rule fallback with `modelError` on any failure; the sidebar shows a small
  "local model unavailable" note (spec §7). `@xenova/transformers` added to
  the extension; `https://*.r2.dev/*` + `https://cdn.jsdelivr.net/*`
  host permissions.
- **Tests**: adapter unit tests (feature-extraction head math, Tensor shapes,
  head-fetch failure, wrong-shape fallback, pipelineFactory) + corpus
  generator tests; full workspace gates green.

### North-star instrumentation (spec §4)

`GET /api/stats` now returns an `improvement` block (defined in
`workers/src/db/events.ts` → `personalImprovement`, pg-mem tested):

- `pqs_delta_4w` — current 7-day avg minus the 7-day avg 21-28 days ago (the
  spec north star: PQS up ≥10 pts over 4 weeks). Null until both windows have
  data.
- `reprompt_rate` / `reprompt_rate_prev` — share of events whose
  `prompt_hash` was seen earlier in the last 30 days / previous 30 days
  (spec KPI: re-prompt rate reduction ≥30%; the extension dedupes consecutive
  repeats, so this measures genuine re-use).
- `active_weeks` — distinct 7-day buckets (of the last 4) with ≥1 event
  (weekly retention signal; spec: 45% week-4 retention).

The dashboard (Progress → "North-star (spec §4)") shows the 4-week lift card
(green ≥10 pts), the re-prompt rate with the prior-month delta, and active
weeks. The journey e2e asserts the block's shape; team/global aggregates are
future work.

## How to verify

```bash
npm ci && npm run typecheck && npm run lint && npm run format:check && npm run test && npm run build
node e2e/api-smoke.mjs                                          # live smoke vs deployed endpoints
# full-stack journey (local worker + real RDS/Vectorize/OpenAI):
npm run dev:local -w workers                                   # starts wrangler dev on 127.0.0.1:8788
#   (exports CLOUDFLARE_API_TOKEN/ACCOUNT_ID + the Hyperdrive local string
#    from workers/.dev.vars; that string must end in ?sslmode=require)
# second shell, DATABASE_URL exported from workers/.dev.vars:
DATABASE_URL=$DATABASE_URL node e2e/journey.mjs
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
