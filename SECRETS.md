# Revealyst — Secrets & Credentials

This document lists every credential the project needs, where to get it, and how
it is stored. **Never commit real secrets.** Local dev secrets go in
`workers/.dev.vars` (git-ignored); CI/CD secrets are GitHub Actions secrets.

## GitHub Actions secrets (repo-level)

| Secret                      | Purpose                                | Where to get it                                                                                                                                                                 |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`      | Deploy Workers/Pages, manage Vectorize | Cloudflare dashboard → My Profile → API Tokens → Create Token. Permissions: `Workers Scripts:Edit`, `Workers KV:Edit`, `Pages:Edit`, `Vectorize:Edit`, `Account Settings:Read`. |
| `CLOUDFLARE_ACCOUNT_ID`     | Cloudflare account identifier          | Cloudflare dashboard → right sidebar of any page (not secret, but kept in secrets for convenience).                                                                             |
| `OPENAI_API_KEY`            | Embeddings + suggestion generation     | platform.openai.com → API keys                                                                                                                                                  |
| `AWS_ACCESS_KEY_ID`         | Terraform provisioning of RDS          | AWS IAM → create user with a scoped policy (EC2/RDS full) → access keys                                                                                                         |
| `AWS_SECRET_ACCESS_KEY`     | Terraform provisioning of RDS          | Same IAM user                                                                                                                                                                   |
| `AWS_REGION`                | RDS region, e.g. `us-east-1`           | —                                                                                                                                                                               |
| `DATABASE_URL`              | Worker → RDS connection                | Produced by Terraform after first apply; set afterwards                                                                                                                         |
| `AWS_SES_ACCESS_KEY_ID`     | AWS SES sending (magic-link email)     | AWS IAM → SES-sending user (policy: `ses:SendEmail` on `revealyst.com`)                                                                                                         |
| `AWS_SES_SECRET_ACCESS_KEY` | AWS SES sending (magic-link email)     | Same IAM user                                                                                                                                                                   |

### Setting secrets

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set OPENAI_API_KEY
gh secret set AWS_ACCESS_KEY_ID
gh secret set AWS_SECRET_ACCESS_KEY
gh secret set AWS_REGION
gh secret set DATABASE_URL
gh secret set AWS_SES_ACCESS_KEY_ID
gh secret set AWS_SES_SECRET_ACCESS_KEY
```

## Worker secrets (Cloudflare)

Runtime secrets for the deployed Worker, set with Wrangler after deploy:

```bash
npx wrangler secret put OPENAI_API_KEY   # --from-env or interactive
npx wrangler secret put JWT_SECRET
npx wrangler secret put DATABASE_URL
npx wrangler secret put SES_ACCESS_KEY_ID
npx wrangler secret put SES_SECRET_ACCESS_KEY
```

Non-secret SES config lives in `workers/wrangler.toml` `[vars]`:
`SES_REGION` (default `us-east-1`) and `SES_FROM_EMAIL`
(`Revealyst <noreply@e.revealyst.com>`). The SES identity is `revealyst.com`,
with DNS (MX/TXT) set up for the sending subdomain `e.revealyst.com`.

## Local development

```bash
cp workers/.dev.vars.example workers/.dev.vars   # fill in values
npm run dev:local -w workers                      # wrangler dev on 127.0.0.1:8788
```

`npm run dev:local -w workers` (→ `workers/scripts/dev-local.mjs`) exports the
vars wrangler 4.x needs from the **process environment** — `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`
— then runs `wrangler dev`. The Hyperdrive local connection string must include
`?sslmode=require` (RDS rejects plaintext); the example file documents this.
Plain `wrangler dev` from `workers/` works too, but only if those three vars are
already exported in your shell.

## Rotation & hygiene

- Rotate `OPENAI_API_KEY` if it ever leaks; it is never logged.
- `DATABASE_URL` contains the RDS master password — rotate via RDS after any
  suspected exposure.
- PII never belongs in any secret; use dedicated non-privileged service roles
  for Workers where possible (hardening item).
