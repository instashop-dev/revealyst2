# Revealyst RDS provisioning — production deployment notes.

#

# The live pipeline provisions PostgreSQL on AWS RDS with the AWS CLI

# (db/terraform/main.tf is the equivalent reference IaC for a private backend).

#

# ## Flow (deploy.yml → rds job)

# 1. Ensure a master password exists in AWS Secrets Manager (`revealyst/db-password`).

# 2. `describe-db-instances` — create the instance if absent, then wait for it.

# 3. Compose `DATABASE_URL` and run the migrations (`db` workspace).

# 4. Set the Worker secrets (`DATABASE_URL`, `OPENAI_API_KEY`, `JWT_SECRET`,

# `LIBRARY_ENC_KEY`) via `wrangler secret put`.

#

# ## Hardening (post-MVP)

# - Put the RDS instance in a private VPC and reach it via Cloudflare

# Hyperdrive (connection pooling + private network) or a Cloudflare Tunnel.

# - Set stable `JWT_SECRET` and `LIBRARY_ENC_KEY` GitHub secrets so sessions

# and library ciphertext survive redeploys (they are generated per deploy

# until then).

# - Enable `deletion_protection` on the instance.

# - Restrict the security group once a static egress path exists.
