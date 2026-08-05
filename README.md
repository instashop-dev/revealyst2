# Revealyst

_Turn every prompt into a step forward._

Revealyst is a browser extension + web dashboard that sits between non-technical
employees and any LLM (ChatGPT, Claude, Gemini). It **scores prompts in real
time**, gives **one-click actionable suggestions**, tracks **personal skill
growth**, and provides team managers a **privacy-first analytics dashboard** —
without enterprise bloat.

Product spec: [`.reasonix/attachments/clipboard-20260805-151053.039642-000001.md`](.reasonix/attachments/clipboard-20260805-151053.039642-000001.md)

## Monorepo layout

| Directory          | What it is                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `packages/scoring` | Shared prompt scoring engine (rule-based + ONNX adapter w/ fallback). Framework-free, used by extension and web. |
| `extension/`       | Chrome extension (Manifest V3) — React sidebar, content scripts, service worker.                                 |
| `web/`             | React dashboard, hosted on Cloudflare Pages.                                                                     |
| `workers/`         | Cloudflare Workers API (Hono) — suggestions, events, library, team dashboard, auth.                              |
| `db/`              | RDS PostgreSQL migrations + migration runner.                                                                    |
| `vectorize/`       | Cloudflare Vectorize namespace config + prompt-pattern seed/embedding scripts.                                   |
| `ml/`              | ML assets — training notes, ONNX export scripts, model registry.                                                 |

## Prerequisites

- Node.js >= 20 (CI uses 24)
- npm >= 10

## Quickstart

```bash
npm ci                 # install all workspace deps
npm run typecheck      # strict TS across all workspaces
npm run lint           # ESLint (flat config)
npm run format:check   # Prettier
npm run test           # Vitest in every workspace
npm run build          # emit dist/ for each workspace
```

## Secrets & local dev

See [`SECRETS.md`](SECRETS.md) for the full list of required credentials
(GitHub Actions secrets, Cloudflare, OpenAI, AWS) and where to obtain them.

Local dev variables for the Workers API live in `workers/.dev.vars`
(copy from `workers/.dev.vars.example`); they are git-ignored.

## Deployment

Deploys are triggered automatically on merge to `main` (see
`.github/workflows/deploy.yml`) and are gated on the presence of the required
secrets: Cloudflare Workers API, Cloudflare Pages dashboard, AWS RDS via
Terraform, and Vectorize seeding. Until a secret exists, its job is skipped.

## Status

Tracked in detail in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md):

1. Foundation & CI — ✅ done
2. Scoring engine — ✅ done
3. Backend & data — ✅ done (live Supabase + Cloudflare Hyperdrive, round-trip verified)
4. Chrome extension — ✅ done
5. Web dashboard — 🟡 built, merged & deployed; final live verification pending
6. Production readiness — ⬜ pending
