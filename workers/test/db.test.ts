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

describe("personalImprovement (north-star metrics, spec §4)", () => {
  let liftUserId: string;
  let newbieId: string;
  const day = 86_400_000;

  beforeAll(async () => {
    const lift = await repos.users.create("lift@example.com");
    liftUserId = lift.id;
    const newbie = await repos.users.create("newbie@example.com");
    newbieId = newbie.id;

    const insert = (promptHash: string, score: number, daysAgo: number) =>
      repos.events.insert({
        userId: liftUserId,
        userAnonId: "anon-lift",
        teamId: null,
        promptHash,
        score,
        breakdown: {
          specificity: score,
          context: score,
          role_clarity: score,
          output_format: score,
          examples_included: score,
        },
        flags: [],
        llmPlatform: "chatgpt.com",
        createdAt: new Date(Date.now() - daysAgo * day).toISOString(),
      });

    // Current 7-day window: avg 65, one re-prompt (a1 repeated).
    await insert("a1", 60, 1);
    await insert("a1", 70, 2);
    // Baseline window (21-28d ago): avg 48.
    await insert("b1", 50, 22);
    await insert("b2", 40, 23);
    await insert("b3", 55, 25);
    // Previous 30-day window (28-60d ago): one re-prompt (c1 repeated).
    await insert("c1", 60, 40);
    await insert("c1", 60, 45);
  });

  it("computes the 4-week PQS lift from the current vs baseline windows", async () => {
    const imp = await repos.events.personalImprovement(liftUserId);
    expect(imp.currentAvg).toBe(65); // round((60+70)/2)
    expect(imp.baselineAvg).toBe(48); // round((50+40+55)/3)
    expect(imp.pqsDelta4w).toBe(17); // 65 - 48
  });

  it("computes re-prompt rates for the current and previous 30-day windows", async () => {
    const imp = await repos.events.personalImprovement(liftUserId);
    // last 30d: 5 events [a1,a1,b1,b2,b3] → 1 repeat → 0.2
    expect(imp.repromptRate).toBe(0.2);
    // previous 30d: 2 events [c1,c1] → 1 repeat → 0.5
    expect(imp.repromptRatePrev).toBe(0.5);
  });

  it("counts active weeks out of the last 4 buckets", async () => {
    const imp = await repos.events.personalImprovement(liftUserId);
    // events land in bucket 0 (current week) and bucket 3 (21-28d ago)
    expect(imp.activeWeeks).toBe(2);
  });

  it("returns nulls for a user with no events (too new to judge)", async () => {
    const imp = await repos.events.personalImprovement(newbieId);
    expect(imp.pqsDelta4w).toBeNull();
    expect(imp.currentAvg).toBeNull();
    expect(imp.baselineAvg).toBeNull();
    expect(imp.repromptRate).toBeNull();
    expect(imp.repromptRatePrev).toBeNull();
    expect(imp.activeWeeks).toBe(0);
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

  it("removes a prompt and its whole version chain", async () => {
    const saved = await repos.library.insert({
      teamId,
      title: "Chain root",
      encryptedPrompt: "enc1",
      promptHash: "sha256-chain-1",
      tags: [],
      createdBy: userId,
      score: 60,
    });
    const v2 = await repos.library.createVersion(saved, {
      encryptedPrompt: "enc2",
      promptHash: "sha256-chain-2",
      title: "Chain v2",
      tags: [],
      score: 70,
      createdBy: userId,
    });
    const v3 = await repos.library.createVersion(v2, {
      encryptedPrompt: "enc3",
      promptHash: "sha256-chain-3",
      title: "Chain v3",
      tags: [],
      score: 80,
      createdBy: userId,
    });

    // Deleting a middle version must take the whole chain with it
    // (parent_id has no cascade — orphaned versions would stay listed).
    const removed = await repos.library.remove(v2.id);
    expect(removed).toBe(3);
    expect(await repos.library.findById(saved.id)).toBeUndefined();
    expect(await repos.library.findById(v2.id)).toBeUndefined();
    expect(await repos.library.findById(v3.id)).toBeUndefined();
    expect(await repos.library.list(teamId, { search: "Chain" })).toMatchObject({ total: 0 });
  });
});

describe("feedback repo", () => {
  it("records suggestion feedback", async () => {
    await expect(repos.feedback.insert(userId, "add_role", true)).resolves.toBeUndefined();
  });
});
