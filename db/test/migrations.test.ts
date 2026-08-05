import { randomUUID } from "node:crypto";
import { DataType, newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrations.js";
import { createPgPoolDb } from "../src/sql-db.js";

const EXPECTED_TABLES = [
  "users",
  "teams",
  "team_members",
  "prompt_events",
  "library_prompts",
  "suggestions_feedback",
  "schema_migrations",
];

/** pg-mem does not implement gen_random_uuid(); register it like PG 13+. */
function makeDb(): ReturnType<typeof newDb> {
  const mem = newDb();
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  return mem;
}

describe("migrations (pg-mem)", () => {
  it("applies 001_init.sql and creates all six tables + schema_migrations", async () => {
    const mem = makeDb();
    const pg = mem.adapters.createPg();
    const client = new pg.Client();
    await client.connect();

    const applied = await runMigrations(client);
    expect(applied).toEqual(["001_init.sql"]);

    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = rows.map((r: { table_name: string }) => r.table_name);
    for (const table of EXPECTED_TABLES) {
      expect(names).toContain(table);
    }
    await client.end();
  });

  it("is idempotent: a second run applies nothing", async () => {
    const mem = makeDb();
    const pg = mem.adapters.createPg();
    const pool = new pg.Pool();
    const first = await runMigrations(pool);
    const second = await runMigrations(pool);
    expect(first).toEqual(["001_init.sql"]);
    expect(second).toEqual([]);
  });

  it("supports inserts and selects through the SqlDb wrapper", async () => {
    const mem = makeDb();
    const pg = mem.adapters.createPg();
    const pool = new pg.Pool();
    await runMigrations(pool);

    const db = createPgPoolDb(pool);
    await db.query("INSERT INTO users (email) VALUES ($1)", ["jamie@example.com"]);
    await db.query("INSERT INTO teams (name) VALUES ($1) RETURNING id", ["Acme"]);

    const { rows } = await db.query<{ email: string; plan: string }>(
      "SELECT email, plan FROM users WHERE email = $1",
      ["jamie@example.com"],
    );
    expect(rows[0]?.email).toBe("jamie@example.com");
    expect(rows[0]?.plan).toBe("free");
  });

  it("exposes the spec's key columns on the six tables", async () => {
    const mem = makeDb();
    const pg = mem.adapters.createPg();
    const client = new pg.Client();
    await client.connect();
    await runMigrations(client);

    const { rows } = await client.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
    );
    const columns = new Map<string, string[]>();
    for (const row of rows as Array<{ table_name: string; column_name: string }>) {
      columns.set(row.table_name, [...(columns.get(row.table_name) ?? []), row.column_name]);
    }

    const specColumns: Record<string, string[]> = {
      users: ["id", "email", "plan", "personal_score_trend", "preferences"],
      teams: ["id", "name", "created_by", "billing_status", "settings"],
      team_members: ["team_id", "user_id", "role", "anon_alias"],
      prompt_events: [
        "id",
        "user_anon_id",
        "team_id",
        "prompt_hash",
        "score",
        "breakdown",
        "flags",
        "llm_platform",
        "created_at",
      ],
      library_prompts: [
        "id",
        "team_id",
        "title",
        "prompt_text_encrypted",
        "tags",
        "usage_count",
        "version",
        "parent_id",
      ],
      suggestions_feedback: ["user_id", "suggestion_id", "was_accepted"],
    };
    for (const [table, expected] of Object.entries(specColumns)) {
      for (const col of expected) {
        expect(columns.get(table), `${table}.${col}`).toContain(col);
      }
    }
    await client.end();
  });
});
