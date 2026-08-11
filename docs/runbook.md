# Revealyst — Operations Runbook

> For operators. Architecture: `docs/architecture.md`. Plan: `IMPLEMENTATION_PLAN.md`.

## Live endpoints

| What          | URL                                                 |
| ------------- | --------------------------------------------------- |
| Workers API   | `https://revealyst-workers.thapi.workers.dev`       |
| OpenAPI spec  | `…/api/openapi.json` (+ human page at `…/api/docs`) |
| Web dashboard | `https://revealyst-web.pages.dev`                   |
| Repo          | `github.com/instashop-dev/revealyst2`               |

## Health checks

```bash
curl -sf https://revealyst-workers.thapi.workers.dev/api/health          # {"status":"ok",...}
curl -sf -o /dev/null -w "%{http_code}\n" https://revealyst-web.pages.dev/  # 200
node e2e/api-smoke.mjs                                                    # full live smoke
```

The deploy pipeline runs two smoke layers after every deploy:

- `smoke` — `node e2e/api-smoke.mjs`: public surface of the live API + web
  dashboard (health, OpenAPI, auth shape, suggestion engine, session-auth
  boundaries, magic link, SPA fallback).
- `journey` — `node e2e/journey.mjs`: full authenticated journey against a
  local `wrangler dev` worker wired to the real RDS/Vectorize/OpenAI
  (magic-link auth → events → stats → team lifecycle → library), then
  removes its own test rows.

Local: `node e2e/api-smoke.mjs` against the live deploy;
`node e2e/journey.mjs` against a local `wrangler dev` worker with `DEV_MODE=true`.

To run the journey locally, start the worker with the dev launcher (it exports
the env vars wrangler 4.x needs — Cloudflare auth + the Hyperdrive local
connection string with `?sslmode=require`):

```bash
npm run dev:local -w workers          # wrangler dev on 127.0.0.1:8788 (DEV_MODE=true in .dev.vars)
# in a second shell, with DATABASE_URL exported (workers/.dev.vars):
node e2e/journey.mjs                  # self-cleaning; removes its test rows
```

Notes:

- The Hyperdrive local connection string must carry `?sslmode=require` or RDS
  rejects the plaintext connection (`no pg_hba.conf entry ... no encryption`).
- The local `OPENAI_API_KEY` must be valid for the suggestion engine to use the
  Vectorize→LLM pipeline locally; otherwise it transparently falls back to
  static patterns (logged as `[suggestions] vectorize+llm failed ...`).
- Journey runs are slow from remote dev machines (each query is a fresh TLS
  connection to RDS); expect several minutes.

## Deployment

Merges to `main` trigger `.github/workflows/deploy.yml` (jobs, gated on
secrets): `gate` → `vectorize` → `workers` (deploy + `wrangler secret put`) →
`rds` (migrations + Hyperdrive ensure) → `pages` → `smoke` → `journey`, plus
`models` (ONNX scorer artifact → R2).

- Deploys are gated on secret presence; missing secrets skip their job.
- `DATABASE_URL` is user-provisioned (AWS RDS) and proxied through
  the Hyperdrive config `revealyst-rds` (id pinned in
  `workers/wrangler.toml`).
- CI runs typecheck / lint / format / test / build on every PR and push
  (`.github/workflows/ci.yml`).

### ONNX prompt-scorer model (spec §5.2)

The extension loads the trained int8 scorer from Cloudflare R2 at runtime,
served by the API worker's `GET /models/*` route (R2 binding `MODELS` →
`revealyst-models`, see `workers/src/routes/models.ts`). `MODEL_BASE_URL` in
`extension/src/lib/model-config.ts` already points at
`https://revealyst-workers.thapi.workers.dev/models/prompt-scorer-v1`.

One-time setup (uploading the artifact to R2):

1. `npx wrangler r2 bucket create revealyst-models` (also done by the `models`
   deploy job; skips silently when it exists).
2. Upload the artifact — the deploy `models` job runs
   `node ml/scripts/upload.mjs` automatically, or manually:
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` set, or
   `npx wrangler r2 object put revealyst-models/prompt-scorer-v1/<file> --file ...`
   for each file under `ml/models/prompt-scorer-v1/` (onnx/model_quantized.onnx,
   config.json, tokenizer*.json, vocab.txt, special_tokens_map.json, head.json).
3. Verify: `curl -sI https://revealyst-workers.thapi.workers.dev/models/prompt-scorer-v1/head.json`
   → 200. The worker's `models` route returns the R2 object with `Cache-Control:
public, max-age=3600, immutable`.

Note: the R2 bucket's r2.dev public URL was found unreliable on this account
(404/401 even after enabling) — hence the worker-served route, which is also
the production-recommended pattern. If you later attach a custom domain
(`models.revealyst.com`), update `MODEL_BASE_URL` to match.

Until the artifacts are uploaded the model URL 404s: the extension logs a
`modelError` and scores with the rule engine (spec §7 fallback) — the product
keeps working, only the local-model path is inert.

Retraining (rule distillation until human-labeled data exists):

```bash
npm run generate:corpus -w ml          # deterministic synthetic corpus (ml/data/)
ml/.venv/Scripts/python -m pip install -r ml/python/requirements.txt
ml/.venv/Scripts/python ml/python/train.py --epochs 6
ml/.venv/Scripts/python ml/python/eval.py   # MAE + latency vs rule labels
```

Artifact: `ml/models/prompt-scorer-v1/` (`model_quantized.onnx` int8, `head.json`,
tokenizer, provenance `README.md`). The fp32 `model.onnx` and checkpoints are
gitignored; only the int8 artifact + metadata are committed. Watch the eval
MAE — retrain when it drifts.

### North-star metrics (spec §4)

`GET /api/stats` now returns an `improvement` block, defined in
`workers/src/db/events.ts` (`personalImprovement`):

- `pqs_delta_4w` — current 7-day avg score minus the 7-day avg 21-28 days
  ago (the spec north star: PQS up ≥10 pts over 4 weeks). Null until the user
  has data in both windows.
- `reprompt_rate` / `reprompt_rate_prev` — share of events whose
  `prompt_hash` was seen earlier in the last 30 days / the previous 30 days
  (spec KPI: re-prompt rate reduction ≥30%). The extension dedupes
  consecutive repeats, so this measures genuine re-use.
- `active_weeks` — distinct 7-day buckets (of the last 4) with ≥1 event
  (weekly retention signal; spec: 45% week-4 retention).

The dashboard shows these in Progress → "North-star (spec §4)". Team/global
aggregates of the same metrics are future work.

### Weekly manager digest (spec §4 retention)

Every Monday 08:00 UTC the worker's `scheduled` handler runs
`runWeeklyDigest` (`workers/src/digest.ts`): for each team with prompt
activity in the last 7 days it aggregates this week vs the previous week
(team average PQS + delta, prompt volume, member improvement, most common
weakness, top library prompts) and emails every manager via SES
(`sendWeeklyDigestEmail`, same identity as magic links).

- **Trigger**: cron `0 8 * * 1` in `workers/wrangler.toml` `[triggers]`.
- **On demand**: `POST /api/admin/digest` (app creator only) runs the same
  path and returns the summary — use it to test or backfill a missed Monday.
- **Skip rules**: teams with zero prompts in the last 7 days, and teams with
  no manager on record, get no email.
- **SES unavailable / DEV_MODE**: the digest is logged (`[digest] …`) and
  counted, nothing is delivered — local dev and CI behave identically.
- **Privacy**: computed from the same anonymised data as the team dashboard
  (scores, hashes, aggregates). Raw prompt text never appears in the email.
- **No migration**: computed on the fly from `prompt_events` +
  `library_prompts`.

### Migrations

`db/migrations/*.sql` are applied by `node db/dist/run-migrations.js` in the
`rds` job (recorded in `schema_migrations`). Local: `npm run build -w db &&
node db/dist/run-migrations.js` with `DATABASE_URL` set.

## Secrets

Full list: `SECRETS.md`. Worker secrets are set via
`echo "$VALUE" | npx wrangler secret put NAME` (deploy job or manually).
GitHub secrets include `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`OPENAI_API_KEY`, `JWT_SECRET`, `LIBRARY_ENC_KEY`, `DATABASE_URL`,
`AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `ADMIN_EMAILS`.

## Observability

- **Workers Logs**: `[observability] enabled = true` in `wrangler.toml` —
  view in the Cloudflare dashboard (Workers → revealyst-workers → Logs).
- **Request log format**: `[api] METHOD /path STATUS DURATIONms ray=<cf-ray>`
  — query strings and bodies are never logged (magic links are credentials).
- **Watch for**:
  - `[api] … 5xx` spikes and `[api] unhandled error on …` — correlate via
    `ray=`; check the DB/upstream.
  - `[auth] magic link email send failed:` — SES rejections (identity not
    verified, sandbox recipient not verified, quota).
  - `[auth] magic link suppressed (recipient cooldown): <hash>` — expected
    under repeat requests; a flood suggests an attacker.
  - `[auth] magic link jti insert failed:` — DB issue; links will be
    rejected at verify (fails closed).
- **SES**: delivery metrics live in the AWS SES console (sends, bounces,
  complaints) for the `e.revealyst.com` sending subdomain.
- **CF dashboards**: Workers analytics, Vectorize queries, Hyperdrive
  connection metrics.

## Known quirks & accepted risks

1. **Rate limiting is per-isolate** (`workers/src/rate-limit.ts`) — in-memory,
   per-IP, resets on isolate churn. For abuse protection, enable
   **Cloudflare WAF / rate limiting rules** in front of `/api/auth/magic`
   (e.g. 20 req/min/IP) — the runbook assumes this is configured.
2. **Email subaddressing** (`user+tag@example.com`) bypasses the per-recipient
   cooldown by design (plus-addressing is provider-specific; stripping it
   would break delivery for non-Gmail users). Combined with (1), impact is
   bounded.
3. **Unverified-user rows accumulate** — users are created at magic-link
   request time (needed for the jti FK + token subject). Inline pruning was
   considered and rejected (risk of deleting active users — no sessions
   table — and FK violations). A scheduled job may add this later
   (`suggestions_feedback`/`library_prompts` FKs must be handled).
4. **SES sandbox**: until SES production access is granted, only verified
   recipients can receive email; the API still returns `200` (uniform
   anti-oracle) — verify delivery in the SES console.
5. **GitHub runners lack IPv6 egress** — migration/deploy steps force IPv4
   resolution for the DB host; do not "fix" by switching back to IPv6-first.
6. **Hyperdrive**: the live config is `revealyst-rds` (id pinned in
   `wrangler.toml`; the stale `revealyst-neon`, `revealyst-pooler` and
   `revealyst-pooler-2` configs are deleted by the deploy pipeline).
   **Refresh note**: on 2026-08-06 the old `revealyst-pooler` config's origin
   connections went stale (intermittent 10s+ hangs on every query) — a fresh
   config + per-request connections resolved it. If auth hangs recur,
   `npx wrangler hyperdrive update revealyst-rds --connection-string="$DATABASE_URL"`
   or recreate the config (and repin the id in `wrangler.toml`).
7. **DB connection model**: per-request connections (Cloudflare forbids
   socket I/O shared across requests — a pooled driver intermittently errors
   "Cannot perform I/O on behalf of a different request"). Each request opens
   one connection, closed by middleware after the response. Every query has a
   15s client-side timeout with ONE retry on a fresh connection — covers
   Supabase-era free-tier database pause/wake (10-30s) and stale sockets. On
   timeout the pool is recycled.
8. **Static suggestion fallback** — if OpenAI or Vectorize is down, the API
   degrades to deterministic static patterns (`source: "static"`), never 5xx.

## Troubleshooting

| Symptom                                           | Likely cause / action                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/auth/magic` hangs or 500s on new users | (fixed) — see the 2026-08-06 incident: stale Hyperdrive origin pool + cross-request socket sharing + DB pause/wake (Supabase era). Current design: per-request connections, 15s query timeout + one retry (also on `CONNECTION_CLOSED`), fresh `revealyst-rds` config. If it recurs: check `[db] QUERY TIMED OUT` logs, `curl /api/health?db=1`, verify the DB is reachable (`SELECT 1` from a client), and refresh the Hyperdrive config. |
| Magic link email never arrives                    | SES sandbox recipient verification; identity `revealyst.com` / subdomain `e.revealyst.com` DNS (MX/TXT); check SES console + `[auth] magic link email send failed:` log.                                                                                                                                                                                                                                                                   |
| Link rejected at verify (`401`)                   | Token consumed (single-use — request a new link), expired (>15 min), or jti insert failed (DB).                                                                                                                                                                                                                                                                                                                                            |
| Suggestions return `source: "static"`             | Upstream (OpenAI/Vectorize) unavailable or rate limited — transient by design.                                                                                                                                                                                                                                                                                                                                                             |
| Deploy `rds` job fails on migration               | IPv4 resolution of DB host (see quirk 5); TLS/CA of RDS.                                                                                                                                                                                                                                                                                                                                                                                   |
| 429s on magic                                     | Per-IP limiter (5/min) or Cloudflare WAF rule — slow down / wait a minute.                                                                                                                                                                                                                                                                                                                                                                 |

## Operational procedures

- **Release**: after merge + green deploy + smoke, tag:
  `git tag v0.1.0 && git push origin v0.1.0` (or `gh release create`).
- **Rotate `JWT_SECRET`**: invalidates all sessions and magic links — do
  during maintenance; users re-auth via magic link.
- **Rotate SES keys**: update `AWS_SES_*` GitHub secrets, then the next
  deploy re-puts the Worker secrets.
- **DB backup**: AWS RDS automated backups (7-day retention); verify in the
  RDS console.
