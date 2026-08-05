import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal, dependency-free migration runner contract: anything that can run
 * parameterless SQL queries (a pg Client/Pool, a pg-mem adapter in tests, or
 * the Worker's postgres.js wrapper) can apply migrations.
 */
export interface SqlRunner {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

/**
 * Remove full-line SQL comments (`-- ...`) before statement splitting so
 * comment-only blocks are never executed as statements.
 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/**
 * Apply every *.sql migration in `dir` (default db/migrations) in filename
 * order, skipping versions already recorded in the `schema_migrations` table
 * (created here if missing). Each file may contain multiple statements split
 * on ';' — safe for our DDL, which never embeds a semicolon inside literals.
 *
 * Returns the list of versions applied in this run.
 */
export async function runMigrations(
  runner: SqlRunner,
  dir = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  // pg-mem rejects `CREATE TABLE IF NOT EXISTS` on an existing table, so check
  // existence via information_schema (works on Postgres and pg-mem alike).
  const existing = (await runner.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'",
  )) as { rows: Array<{ table_name: string }> };
  if (existing.rows.length === 0) {
    await runner.query(`CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )`);
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set<string>();

  const { rows } = (await runner.query("SELECT version FROM schema_migrations")) as {
    rows: Array<{ version: string }>;
  };
  for (const row of rows) {
    applied.add(String(row.version));
  }

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    const statements = stripSqlComments(sql)
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) {
      await runner.query(statement);
    }
    await runner.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    newlyApplied.push(file);
  }
  return newlyApplied;
}
