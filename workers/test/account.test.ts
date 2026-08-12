import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPoolDb, runMigrations } from "@revealyst/db";
import { DataType, newDb } from "pg-mem";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/env.js";
import { app } from "../src/index.js";
import { createRepos } from "../src/db/index.js";
import { encryptPrompt, sha256Hex } from "../src/crypto.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const TEST_SECRET = "test-secret-0123456789abcdef0123456789abcdef";

let env: WorkerEnv;
let db: ReturnType<typeof createPgPoolDb>;

const json = (body: unknown, token?: string, method = "POST"): RequestInit => ({
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

async function makeEnv(): Promise<WorkerEnv> {
  const mem = newDb();
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  await runMigrations(pool, MIGRATIONS_DIR);
  db = createPgPoolDb(pool);
  return {
    DATABASE_URL: "postgres://unused",
    JWT_SECRET: TEST_SECRET,
    OPENAI_API_KEY: "test-openai-key",
    APP_URL: "http://localhost:8788",
    LIBRARY_ENC_KEY: TEST_SECRET,
    DEV_MODE: "true",
    RATE_LIMIT_DISABLED: "true",
    _DB: db,
  };
}

async function login(email: string): Promise<string> {
  const magic = await app.request("/api/auth/magic", json({ email }), env);
  expect(magic.status).toBe(200);
  const { dev_link } = (await magic.json()) as { dev_link: string };
  const token = dev_link.split("token=")[1]!;
  const verify = await app.request("/api/auth/verify", json({ token }), env);
  expect(verify.status).toBe(200);
  return ((await verify.json()) as { token: string }).token;
}

describe("DELETE /api/account (Settings → Delete my data)", () => {
  beforeAll(async () => {
    env = await makeEnv();
  });

  it("requires a session (401 without a token)", async () => {
    const res = await app.request("/api/account", { method: "DELETE" }, env);
    expect(res.status).toBe(401);
  });

  it("erases the user, their events, feedback, library prompts, invites and solo team", async () => {
    const token = await login("jamie@example.com");
    const repos = createRepos(db);
    const me = await repos.users.findByEmail("jamie@example.com");
    expect(me).toBeDefined();
    const userId = me!.id;

    // Seed: solo team + member team, a library prompt, an event, feedback.
    const soloTeam = await repos.teams.create("Solo Studio", userId);
    await repos.library.insert({
      teamId: soloTeam.id,
      title: "Cold email",
      encryptedPrompt: await encryptPrompt("Write a cold email for a prospect", TEST_SECRET),
      promptHash: await sha256Hex("Write a cold email for a prospect"),
      tags: ["email"],
      createdBy: userId,
      score: 62,
    });
    await repos.events.insert({
      userId,
      userAnonId: "anon-1",
      teamId: soloTeam.id,
      promptHash: "abc123",
      score: 62,
      breakdown: {
        specificity: 60,
        context: 55,
        role_clarity: 25,
        output_format: 80,
        examples_included: 10,
      },
      flags: ["missing_role"],
      llmPlatform: "chatgpt",
    });
    await repos.feedback.insert(userId, "add_role", true);

    const other = await repos.users.create("rohan@example.com");
    const sharedTeam = await repos.teams.create("Agency", userId);
    await repos.teams.addMember(sharedTeam.id, other.id, "member", "User_A");

    const res = await app.request(
      "/api/account",
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);

    // User row gone; session token now dead.
    expect(await repos.users.findByEmail("jamie@example.com")).toBeUndefined();
    const meAfter = await app.request(
      "/api/auth/me",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(meAfter.status).toBe(401);

    // Their data is gone.
    const events = await db.query<{ id: string }>(
      "SELECT id FROM prompt_events WHERE user_id = $1",
      [userId],
    );
    expect(events.rows).toHaveLength(0);
    const feedback = await db.query<{ id: string }>(
      "SELECT user_id FROM suggestions_feedback WHERE user_id = $1",
      [userId],
    );
    expect(feedback.rows).toHaveLength(0);
    const prompts = await db.query<{ id: string }>(
      "SELECT id FROM library_prompts WHERE team_id = $1",
      [soloTeam.id],
    );
    expect(prompts.rows).toHaveLength(0);

    // Solo team deleted; shared team survives with the other member.
    const soloAfter = await db.query<{ id: string }>("SELECT id FROM teams WHERE id = $1", [
      soloTeam.id,
    ]);
    expect(soloAfter.rows).toHaveLength(0);
    const sharedAfter = await db.query<{ id: string }>("SELECT id FROM teams WHERE id = $1", [
      sharedTeam.id,
    ]);
    expect(sharedAfter.rows).toHaveLength(1);
    const members = await db.query<{ user_id: string }>(
      "SELECT user_id FROM team_members WHERE team_id = $1",
      [sharedTeam.id],
    );
    expect(members.rows.map((r) => r.user_id)).toEqual([other.id]);
    const creatorAfter = await db.query<{ created_by: string | null }>(
      "SELECT created_by FROM teams WHERE id = $1",
      [sharedTeam.id],
    );
    expect(creatorAfter.rows[0]!.created_by).toBeNull();
  });
});
