import { Client } from "pg";
import { lookup } from "node:dns/promises";
import { runMigrations } from "./migrations.js";

/**
 * CLI entry: apply pending migrations to the PostgreSQL database pointed at by
 * DATABASE_URL. Used by CI (and locally) to migrate the RDS instance.
 *
 *   DATABASE_URL=postgres://... node dist/run-migrations.js
 */
async function main(): Promise<void> {
  // GitHub runners lack IPv6 egress and cloud Postgres hosts commonly resolve
  // to IPv6 first (ENETUNREACH) — prefer IPv4 for all lookups.
  setDefaultResultOrder("ipv4first");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  // pg 8.13+ prefers sslmode from the connection string (with a confusing
  // libpq-compat mapping), so strip it and pass the ssl option directly:
  // encryption on, CA verification off for the MVP (the database is reached
  // over the public internet — see db/terraform/README.md hardening notes).
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  const client = new Client({
    connectionString: url.toString(),
    ssl: process.env.PGSSLMODE === "disable" ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const applied = await runMigrations(client);
    console.log(
      applied.length > 0 ? `Applied migrations: ${applied.join(", ")}` : "No pending migrations.",
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
