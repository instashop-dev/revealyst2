import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPoolDb } from "@revealyst/db";
import { runMigrations } from "@revealyst/db";
import { DataType, newDb } from "pg-mem";
import { beforeAll, describe, expect, it } from "vitest";
import { createRepos, type Repos } from "../src/db/index.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

let repos: Repos;
let userId: string;
let managerId: string;
let teamId: string;

beforeAll(async () => {
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
  repos = createRepos(createPgPoolDb(pool));

  // Seed: two users + one team
  const jamie = await repos.users.create("jamie@example.com");
  const rohan = await repos.users.create("rohan@example.com");
  userId = jamie.id;
  managerId = rohan.id;
  const team = await repos.teams.create("Acme Agency", managerId);
  teamId = team.id;
  await repos.teams.addMember(teamId, userId, "member", "User_A");
  await repos.teams.addMember(teamId, managerId, "manager", "User_B");
});

describe("users repo", () => {
  it("creates and looks up users", async () => {
    const byEmail = await repos.users.findByEmail("jamie@example.com");
    expect(byEmail?.id).toBe(userId);
    expect(byEmail?.plan).toBe("free");
    const byId = await repos.users.getById(userId);
    expect(byId?.email).toBe("jamie@example.com");
  });
});

describe("teams repo", () => {
  it("tracks members and roles", async () => {
    const members = await repos.teams.listMembers(teamId);
    expect(members).toHaveLength(2);
    expect(await repos.teams.isManager(teamId, managerId)).toBe(true);
    expect(await repos.teams.isManager(teamId, userId)).toBe(false);
    await repos.teams.setRole(teamId, userId, "manager");
    expect(await repos.teams.isManager(teamId, userId)).toBe(true);
  });
});

describe("events repo", () => {
  beforeAll(async () => {
    await repos.events.insert({
      userId,
      userAnonId: "anon-jamie",
      teamId,
      promptHash: "hash1",
      score: 45,
      breakdown: {
        specificity: 40,
        context: 50,
        role_clarity: 30,
        output_format: 50,
        examples_included: 10,
      },
      flags: ["missing_role", "missing_output_format"],
      llmPlatform: "chat.openai.com",
    });
    await repos.events.insert({
      userId,
      userAnonId: "anon-jamie",
      teamId,
      promptHash: "hash2",
      score: 82,
      breakdown: {
        specificity: 90,
        context: 80,
        role_clarity: 90,
        output_format: 100,
        examples_included: 40,
      },
      flags: [],
      llmPlatform: "claude.ai",
    });
    await repos.events.insert({
      userId: null,
      userAnonId: "anon-rohan",
      teamId,
      promptHash: "hash3",
      score: 70,
      breakdown: {
        specificity: 80,
        context: 60,
        role_clarity: 80,
        output_format: 60,
        examples_included: 60,
      },
      flags: ["no_examples"],
      llmPlatform: "chat.openai.com",
    });
    // a stale event outside the window (should be excluded from aggregates)
    await repos.events.insert({
      userId: null,
      userAnonId: "anon-rohan",
      teamId,
      promptHash: "hash4",
      score: 10,
      breakdown: {
        specificity: 10,
        context: 10,
        role_clarity: 10,
        output_format: 10,
        examples_included: 10,
      },
      flags: [],
      llmPlatform: "gemini.google.com",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    // a personal (non-team) event for the user-history assertion
    await repos.events.insert({
      userId,
      userAnonId: "anon-jamie",
      teamId: null,
      promptHash: "hash5",
      score: 55,
      breakdown: {
        specificity: 50,
        context: 60,
        role_clarity: 50,
        output_format: 60,
        examples_included: 20,
      },
      flags: ["low_specificity"],
      llmPlatform: "chat.openai.com",
    });
  });

  it("returns the user's prompt history newest-first", async () => {
    const history = await repos.events.userHistory(userId, "2020-01-01T00:00:00.000Z");
    expect(history).toHaveLength(3);
    expect(history[0]?.prompt_hash).toBe("hash5");
  });

  it("aggregates anonymised team stats within the window", async () => {
    const since = new Date(Date.now() - 86400000).toISOString();
    const stats = await repos.events.teamStats(teamId, since);

    // avg of 45, 82, 70 (the stale 10 is outside the window)
    expect(stats.avgScore).toBe(66);

    // weakness distribution
    const weaknessFlags = stats.commonWeaknesses.map((w) => w.flag).sort();
    expect(weaknessFlags).toEqual(["missing_output_format", "missing_role", "no_examples"]);

    // top prompts by best score
    expect(stats.topPrompts[0]?.prompt_hash).toBe("hash2");
    expect(stats.topPrompts[0]?.best_score).toBe(82);

    // volume by platform (3 in-window events: 2 openai, 1 claude)
    const openai = stats.volumeByPlatform.find((p) => p.llm_platform === "chat.openai.com");
    expect(openai?.count).toBe(2);

    // per-user trend
    const jamie = stats.trendByUser.find((t) => t.user_anon_id === "anon-jamie");
    expect(jamie?.avg_score).toBe(Math.round((45 + 82) / 2));
  });
});

describe("library repo", () => {
  let promptId: string;
  beforeAll(async () => {
    const saved = await repos.library.insert({
      teamId,
      title: "Cold email opener",
      encryptedPrompt: "aabbccdd",
      promptHash: "sha256-abc",
      tags: ["email", "sales"],
      createdBy: userId,
      score: 88,
    });
    promptId = saved.id;
  });

  it("dedupes by hash", async () => {
    expect(await repos.library.countByTeamAndHash(teamId, "sha256-abc")).toBe(1);
    expect(await repos.library.countByTeamAndHash(teamId, "sha256-other")).toBe(0);
  });

  it("lists with search and tag filters", async () => {
    const byTag = await repos.library.list(teamId, { tag: "sales" });
    expect(byTag.total).toBe(1);
    const bySearch = await repos.library.list(teamId, { search: "COLD EMAIL" });
    expect(bySearch.total).toBe(1);
    const empty = await repos.library.list(teamId, { search: "nonsense" });
    expect(empty.total).toBe(0);
    const byScore = await repos.library.list(teamId, { minScore: 90 });
    expect(byScore.total).toBe(0);
  });

  it("tracks usage count", async () => {
    await repos.library.incrementUsage(promptId);
    const updated = await repos.library.findById(promptId);
    expect(updated?.usage_count).toBe(1);
  });
});

describe("feedback repo", () => {
  it("records suggestion feedback", async () => {
    await expect(repos.feedback.insert(userId, "add_role", true)).resolves.toBeUndefined();
  });
});
