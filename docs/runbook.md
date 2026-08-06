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

The deploy pipeline runs the smoke (`node e2e/api-smoke.mjs`) after every
deploy in the `smoke` job.

## Deployment

Merges to `main` trigger `.github/workflows/deploy.yml` (jobs, gated on
secrets): `gate` → `vectorize` → `workers` (deploy + `wrangler secret put`) →
`rds` (migrations + Hyperdrive ensure) → `pages` → `smoke`.

- Deploys are gated on secret presence; missing secrets skip their job.
- `DATABASE_URL` is user-provisioned (Supabase pooler) and proxied through
  the Hyperdrive config `revealyst-pooler` (id pinned in
  `workers/wrangler.toml`).
- CI runs typecheck / lint / format / test / build on every PR and push
  (`.github/workflows/ci.yml`).

### Migrations

`db/migrations/*.sql` are applied by `node db/dist/run-migrations.js` in the
`rds` job (recorded in `schema_migrations`). Local: `npm run build -w db &&
node db/dist/run-migrations.js` with `DATABASE_URL` set.

## Secrets

Full list: `SECRETS.md`. Worker secrets are set via
`echo "$VALUE" | npx wrangler secret put NAME` (deploy job or manually).
GitHub secrets include `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`OPENAI_API_KEY`, `JWT_SECRET`, `LIBRARY_ENC_KEY`, `DATABASE_URL`,
`AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`.

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
6. **Hyperdrive**: `revealyst-pooler` is the live config (id pinned in
   `wrangler.toml`). The stale `revealyst-neon` config is deleted by the
   deploy pipeline (`rds` job) if present.
7. **Static suggestion fallback** — if OpenAI or Vectorize is down, the API
   degrades to deterministic static patterns (`source: "static"`), never 5xx.

## Troubleshooting

| Symptom                                           | Likely cause / action                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/magic` hangs or 500s on new users | (fixed) DB pool exhaustion + orphaned transactions — the worker pools per connection string with `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout` so hung queries abort and release locks. If it recurs, clear stuck backends in Supabase: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle in transaction'`. |
| Magic link email never arrives                    | SES sandbox recipient verification; identity `revealyst.com` / subdomain `e.revealyst.com` DNS (MX/TXT); check SES console + `[auth] magic link email send failed:` log.                                                                                                                                                                                         |
| Link rejected at verify (`401`)                   | Token consumed (single-use — request a new link), expired (>15 min), or jti insert failed (DB).                                                                                                                                                                                                                                                                  |
| Suggestions return `source: "static"`             | Upstream (OpenAI/Vectorize) unavailable or rate limited — transient by design.                                                                                                                                                                                                                                                                                   |
| Deploy `rds` job fails on migration               | IPv4 resolution of DB host (see quirk 5); TLS/CA of pooler.                                                                                                                                                                                                                                                                                                      |
| 429s on magic                                     | Per-IP limiter (5/min) or Cloudflare WAF rule — slow down / wait a minute.                                                                                                                                                                                                                                                                                       |

## Operational procedures

- **Release**: after merge + green deploy + smoke, tag:
  `git tag v0.1.0 && git push origin v0.1.0` (or `gh release create`).
- **Rotate `JWT_SECRET`**: invalidates all sessions and magic links — do
  during maintenance; users re-auth via magic link.
- **Rotate SES keys**: update `AWS_SES_*` GitHub secrets, then the next
  deploy re-puts the Worker secrets.
- **DB backup**: Supabase-managed; verify scheduled backups in the Supabase
  dashboard.
