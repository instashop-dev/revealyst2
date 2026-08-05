import { Client } from "pg";
import { runMigrations } from "./migrations.js";

/**
 * CLI entry: apply pending migrations to the PostgreSQL database pointed at by
 * DATABASE_URL. Used by CI (and locally) to migrate the RDS instance.
 *
 *   DATABASE_URL=postgres://... node dist/run-migrations.js
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  // pg 8.13+ honours sslmode from the connection string over the `ssl`
  // option — force require (encrypt, no CA verification) so self-signed
  // certs do not fail the MVP migration; PGSSLMODE=disable opts out of TLS.
  const url = new URL(databaseUrl);
  url.searchParams.set("sslmode", process.env.PGSSLMODE === "disable" ? "disable" : "require");
  const client = new Client({ connectionString: url.toString() });
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
