import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPoolDb, runMigrations } from "@revealyst/db";
import { DataType, newDb } from "pg-mem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../src/env.js";
import app from "../src/index.js";
import { createRepos } from "../src/db/index.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const TEST_SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const HEX64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let env: WorkerEnv;
let memberUserId: string;
let managerToken: string;
let memberToken: string;
let teamId: string;
let promptId: string;
let inviteeToken: string | undefined;
const openaiFetch = vi.fn();
let seedDb: ReturnType<typeof createPgPoolDb>;

function seedRepos() {
  return createRepos(seedDb);
}

const json = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
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
  const db = createPgPoolDb(pool);
  const repos = createRepos(db);
  await repos.users.create("rohan.sharma@example.com");
  const member = await repos.users.create("jamie@example.com");
  memberUserId = member.id;
  seedDb = db;
  return {
    DATABASE_URL: "postgres://unused",
    JWT_SECRET: TEST_SECRET,
    OPENAI_API_KEY: "test-openai-key",
    APP_URL: "http://localhost:8788",
    VECTORIZE_NAMESPACE: "prompt-patterns",
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

beforeAll(async () => {
  env = await makeEnv();
  openaiFetch.mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", openaiFetch);

  managerToken = await login("rohan.sharma@example.com");
  memberToken = await login("jamie@example.com");

  // Manager creates a team.
  const createRes = await app.request(
    "/api/team",
    json({ name: "Acme Agency" }, managerToken),
    env,
  );
  expect(createRes.status).toBe(201);
  teamId = ((await createRes.json()) as { id: string }).id;

  // Test seam: jamie is an existing member (invite flow is covered separately).
  await seedRepos().teams.addMember(teamId, memberUserId, "member", "User_A");
});

describe("team onboarding (§5.8)", () => {
  it("lists memberships with roles", async () => {
    const res = await app.request("/api/teams", undefined, {
      ...env,
      // requireAuth reads the Authorization header — pass via fetch init
    });
    // Manual request with header:
    const teams = await app.request(
      "/api/teams",
      { method: "GET", headers: { Authorization: `Bearer ${managerToken}` } },
      env,
    );
    expect(teams.status).toBe(200);
    const body = (await teams.json()) as {
      teams: Array<{ id: string; role: string; anonymize_identities: boolean }>;
    };
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0]?.role).toBe("manager");
    expect(body.teams[0]?.anonymize_identities).toBe(true);
    void res;
  });

  it("invites a member via email magic link with a team claim", async () => {
    const invite = await app.request(
      "/api/team/invite",
      json({ team_id: teamId, email: "newperson@example.com" }, managerToken),
      env,
    );
    expect(invite.status).toBe(200);
    const body = (await invite.json()) as { dev_link: string };
    expect(body.dev_link).toContain("token=");

    // The invitee verifies the link → auto-joined to the team.
    const token = body.dev_link.split("token=")[1]!;
    const verify = await app.request("/api/auth/verify", json({ token }), env);
    expect(verify.status).toBe(200);
    inviteeToken = ((await verify.json()) as { token: string }).token;

    const members = await app.request(
      "/api/team/members?team_id=" + teamId,
      { headers: { Authorization: `Bearer ${managerToken}` } },
      env,
    );
    expect(members.status).toBe(200);
    const memberBody = (await members.json()) as {
      members: Array<{ role: string; opt_in_identifiable: boolean }>;
      identifiable_enabled: boolean;
    };
    expect(memberBody.members).toHaveLength(3);
    expect(memberBody.identifiable_enabled).toBe(false); // anonymised + not all opted in
  });

  it("rejects invites from non-managers", async () => {
    const res = await app.request(
      "/api/team/invite",
      json({ team_id: teamId, email: "x@example.com" }, memberToken),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("enforces identifiable mode: anonymisation off requires every member opt-in", async () => {
    // Manager turns anonymisation off — but the member has not opted in.
    const settings = await app.request(
      "/api/team/settings",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${managerToken}` },
        body: JSON.stringify({ team_id: teamId, anonymize_identities: false }),
      },
      env,
    );
    expect(settings.status).toBe(200);
    expect(
      ((await settings.json()) as { anonymize_identities: boolean }).anonymize_identities,
    ).toBe(false);

    const members = await app.request(
      "/api/team/members?team_id=" + teamId,
      { headers: { Authorization: `Bearer ${managerToken}` } },
      env,
    );
    const before = (await members.json()) as {
      identifiable_enabled: boolean;
      members: Array<{ display_name: string }>;
    };
    expect(before.identifiable_enabled).toBe(false);
    // Display names still pseudonymised because not everyone opted in.
    expect(before.members.map((m) => m.display_name)).not.toContain("Rohan S.");

    // Manager opts in… still locked because jamie hasn't.
    await app.request(
      "/api/team/opt-in",
      json({ team_id: teamId, enabled: true }, managerToken),
      env,
    );
    // Member opts in too → still locked because the invited member hasn't.
    const optIn = await app.request(
      "/api/team/opt-in",
      json({ team_id: teamId, enabled: true }, memberToken),
      env,
    );
    expect(((await optIn.json()) as { identifiable_enabled: boolean }).identifiable_enabled).toBe(
      false,
    );
    // Invited member opts in → identifiable finally unlocks (all members).
    if (inviteeToken) {
      const inviteeOptIn = await app.request(
        "/api/team/opt-in",
        json({ team_id: teamId, enabled: true }, inviteeToken),
        env,
      );
      expect(
        ((await inviteeOptIn.json()) as { identifiable_enabled: boolean }).identifiable_enabled,
      ).toBe(true);
    }

    const after = await app.request(
      "/api/team/members?team_id=" + teamId,
      { headers: { Authorization: `Bearer ${managerToken}` } },
      env,
    );
    const afterBody = (await after.json()) as {
      identifiable_enabled: boolean;
      members: Array<{ display_name: string }>;
    };
    expect(afterBody.identifiable_enabled).toBe(true);
    // First name + last initial only — never the full email.
    expect(afterBody.members.map((m) => m.display_name)).toContain("Rohan S.");
    expect(afterBody.members.map((m) => m.display_name)).toContain("Jamie");
    expect(JSON.stringify(afterBody)).not.toContain("@example.com");
  });
});

describe("personal dashboard data (§5.4)", () => {
  beforeAll(async () => {
    // Seed two events for the member (one green, one clarity-pro worthy).
    await app.request(
      "/api/event",
      json(
        {
          prompt_hash: HEX64,
          score: 82,
          flags: [],
          breakdown: {
            specificity: 90,
            context: 80,
            role_clarity: 90,
            output_format: 100,
            examples_included: 40,
          },
          llm_platform: "chat.openai.com",
          timestamp: "2026-08-05T10:00:00.000Z",
        },
        memberToken,
      ),
      env,
    );
    await app.request(
      "/api/event",
      json(
        {
          prompt_hash: HEX64,
          score: 45,
          flags: ["missing_role"],
          breakdown: {
            specificity: 40,
            context: 50,
            role_clarity: 30,
            output_format: 50,
            examples_included: 10,
          },
          llm_platform: "claude.ai",
          timestamp: "2026-08-04T10:00:00.000Z",
        },
        memberToken,
      ),
      env,
    );
    await app.request(
      "/api/feedback",
      json({ suggestion_id: "add_role", was_accepted: true }, memberToken),
      env,
    );
  });

  it("returns the user's own history (no raw text)", async () => {
    const res = await app.request(
      "/api/history?period=30d",
      { headers: { Authorization: `Bearer ${memberToken}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ score: number; prompt_hash: string }> };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]?.score).toBe(82);
    expect(JSON.stringify(body)).not.toContain("Write a");
  });

  it("filters history by platform and min score", async () => {
    const res = await app.request(
      "/api/history?platform=claude.ai&min_score=50",
      { headers: { Authorization: `Bearer ${memberToken}` } },
      env,
    );
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(0); // claude event scores 45 < 50
  });

  it("computes personal stats: counts, radar, streak", async () => {
    const res = await app.request(
      "/api/stats?period=30d",
      { headers: { Authorization: `Bearer ${memberToken}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompts_count: number;
      green_count: number;
      accepted_count: number;
      clarity_count: number;
      radar: Record<string, number>;
      avg_score: number | null;
    };
    expect(body.prompts_count).toBe(2);
    expect(body.green_count).toBe(1);
    expect(body.accepted_count).toBe(1);
    expect(body.clarity_count).toBe(1);
    expect(body.radar.role_clarity).toBe(60);
    expect(body.avg_score).toBe(64);
  });
});

describe("library governance (§5.6)", () => {
  it("saves a prompt then versions an edit", async () => {
    const save = await app.request(
      "/api/library",
      json(
        {
          team_id: teamId,
          prompt_text: "Write a cold email.",
          title: "Cold email",
          tags: ["sales"],
          score: 70,
        },
        memberToken,
      ),
      env,
    );
    expect(save.status).toBe(201);
    promptId = ((await save.json()) as { id: string }).id;

    const edit = await app.request(
      "/api/library/" + promptId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({
          prompt_text: "Write a short cold email for our CRM tool.",
          score: 85,
        }),
      },
      env,
    );
    expect(edit.status).toBe(200);
    const updated = (await edit.json()) as { version: number; id: string };
    expect(updated.version).toBe(2);

    const versions = await app.request(
      `/api/library/${promptId}/versions`,
      { headers: { Authorization: `Bearer ${memberToken}` } },
      env,
    );
    expect(versions.status).toBe(200);
    const vBody = (await versions.json()) as { versions: Array<{ version: number; id: string }> };
    expect(vBody.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("lets managers set notes + Team Standard; blocks members", async () => {
    const asMember = await app.request(
      "/api/library/" + promptId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ is_standard: true }),
      },
      env,
    );
    expect(asMember.status).toBe(403);

    const asManager = await app.request(
      "/api/library/" + promptId,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${managerToken}` },
        body: JSON.stringify({ is_standard: true, notes: "Use this for weekly outreach." }),
      },
      env,
    );
    expect(asManager.status).toBe(200);
    const card = (await asManager.json()) as { is_standard: boolean; notes: string };
    expect(card.is_standard).toBe(true);
    expect(card.notes).toContain("weekly outreach");
  });

  it("lists with sort + returns governance fields", async () => {
    const res = await app.request(
      `/api/library?team_id=${teamId}&sort=highest_score`,
      { headers: { Authorization: `Bearer ${memberToken}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompts: Array<{
        is_standard: boolean;
        notes: string | null;
        last_used_at: string | null;
        score: number | null;
      }>;
    };
    // Highest score first (v2, score 85), governance fields present on every card.
    expect(body.prompts[0]?.score).toBe(85);
    expect(typeof body.prompts[0]?.is_standard).toBe("boolean");
    expect(body.prompts.some((p) => p.is_standard === true)).toBe(true);
    expect(body.prompts.some((p) => typeof p.notes === "string")).toBe(true);
    expect(body.prompts.every((p) => "last_used_at" in p)).toBe(true);
  });
});

describe("team events integrity", () => {
  it("rejects team attribution without a session (401)", async () => {
    const res = await app.request(
      "/api/event",
      json({ prompt_hash: HEX64, score: 50, team_id: teamId }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects team attribution for non-members (403)", async () => {
    const outsider = await login("outsider@example.com");
    const res = await app.request(
      "/api/event",
      json({ prompt_hash: HEX64, score: 50, team_id: teamId }, outsider),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("rejects malformed prompt hashes (400)", async () => {
    const res = await app.request(
      "/api/event",
      json({ prompt_hash: "not-a-hash", score: 50 }),
      env,
    );
    expect(res.status).toBe(400);
  });
});
