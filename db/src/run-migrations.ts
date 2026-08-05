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
  const client = new Client({
    connectionString: databaseUrl,
    // Encryption required; CA verification relaxed for MVP (the database is
    // reached over the public internet — see db/terraform/README.md hardening
    // notes). Set PGSSLMODE=disable to skip TLS entirely.
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
