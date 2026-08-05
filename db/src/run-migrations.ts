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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  // Strip sslmode and pass the ssl option directly (pg 8.13+ prefers the
  // connection-string value; encryption on, CA verification off for MVP).
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  // GitHub runners lack IPv6 egress and cloud Postgres hosts commonly resolve
  // to IPv6 first (ENETUNREACH). Resolve the hostname to a literal IPv4
  // address and connect to that, bypassing node's dual-stack handling.
  const host = url.hostname;
  if (host && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    try {
      const { address } = await lookup(host, { family: 4 });
      url.hostname = address;
    } catch {
      // keep the hostname — the connect error will be more informative
    }
  }
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
