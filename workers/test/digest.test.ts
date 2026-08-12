import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPoolDb, runMigrations } from "@revealyst/db";
import { DataType, newDb } from "pg-mem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../src/env.js";
import type { Repos } from "../src/db/index.js";
import { createRepos } from "../src/db/index.js";
import { buildWeeklyDigest, runWeeklyDigest, WEEK_MS } from "../src/digest.js";
import { buildWeeklyDigestHtml } from "../src/email.js";
import type { WeeklyDigestEmail } from "../src/email.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

const DAY = 86_400_000;

let env: WorkerEnv;
let db: ReturnType<typeof createPgPoolDb>;
let repos: Repos;
let managerId: string;
let memberId: string;
let teamId: string;
let quietTeamId: string;

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
  repos = createRepos(db);

  const manager = await repos.users.create("rohan@example.com");
  const member = await repos.users.create("jamie@example.com");
  managerId = manager.id;
  memberId = member.id;

  const team = await repos.teams.create("Acme Agency", managerId);
  teamId = team.id;
  await repos.teams.addMember(teamId, managerId, "manager", "User_B");
  await repos.teams.addMember(teamId, memberId, "member", "User_A");

  // A second team with a manager but NO events — the digest must skip it.
  const quiet = await repos.teams.create("Quiet Corp", managerId);
  quietTeamId = quiet.id;
  await repos.teams.addMember(quietTeamId, managerId, "manager", "User_C");

  return {
    DATABASE_URL: "postgres://unused",
    JWT_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    OPENAI_API_KEY: "test-openai-key",
    APP_URL: "https://revealyst-web.pages.dev",
    LIBRARY_ENC_KEY: "test-secret-0123456789abcdef0123456789abcdef",
    _DB: db,
  };
}

async function insertEvent(opts: {
  userId: string | null;
  anonId: string;
  score: number;
  daysAgo: number;
  flags?: string[];
  /** Exact timestamp override (defaults to now - daysAgo days). */
  at?: Date;
}) {
  await repos.events.insert({
    userId: opts.userId,
    userAnonId: opts.anonId,
    teamId,
    promptHash: randomUUID(),
    score: opts.score,
    breakdown: {
      specificity: opts.score,
      context: opts.score,
      role_clarity: opts.score,
      output_format: opts.score,
      examples_included: opts.score,
    },
    flags: opts.flags ?? [],
    llmPlatform: "chatgpt.com",
    createdAt: (opts.at ?? new Date(Date.now() - opts.daysAgo * DAY)).toISOString(),
  });
}

beforeAll(async () => {
  env = await makeEnv();
  const now = Date.now();
  // This week (days 0-6): manager improves 60→70, member drops 80→75,
  // plus one weak prompt with a deficiency flag.
  await insertEvent({ userId: managerId, anonId: "anon-manager", score: 60, daysAgo: 1 });
  await insertEvent({ userId: managerId, anonId: "anon-manager", score: 70, daysAgo: 2 });
  await insertEvent({ userId: memberId, anonId: "anon-member", score: 75, daysAgo: 1 });
  await insertEvent({
    userId: memberId,
    anonId: "anon-member",
    score: 30,
    daysAgo: 1,
    flags: ["missing_output_format"],
  });
  // A one-off user active only this week (no baseline → excluded from improvement).
  await insertEvent({ userId: null, anonId: "anon-newbie", score: 90, daysAgo: 1 });
  // Previous week (days 7-13): manager 50, member 80.
  await insertEvent({ userId: managerId, anonId: "anon-manager", score: 50, daysAgo: 8 });
  await insertEvent({ userId: memberId, anonId: "anon-member", score: 80, daysAgo: 8 });
  // Library prompt for the top-prompts section.
  await repos.library.insert({
    teamId,
    title: "Cold email opener",
    encryptedPrompt: "aabb",
    promptHash: "sha256-1",
    tags: ["email"],
    createdBy: managerId,
    score: 88,
  });
  void now;
});

describe("buildWeeklyDigest", () => {
  it("compares this week vs the previous week", async () => {
    const digest = await buildWeeklyDigest(db, repos, teamId);
    expect(digest).not.toBeNull();
    // this week: (60+70+75+30+90)/5 = 65
    expect(digest?.avgScore).toBe(65);
    // prev week: (50+80)/2 = 65
    expect(digest?.prevAvgScore).toBe(65);
    expect(digest?.scoreDelta).toBe(0);
    expect(digest?.promptCount).toBe(5);
    expect(digest?.prevPromptCount).toBe(2);
    expect(digest?.activeUsers).toBe(3);
  });

  it("counts members who improved across both weeks", async () => {
    const digest = await buildWeeklyDigest(db, repos, teamId);
    // Both-week members: manager (avg 65 vs 50 → improved) and member
    // (avg 52.5 vs 80 → not improved). The one-off newbie is excluded.
    expect(digest?.comparedCount).toBe(2);
    expect(digest?.improvedCount).toBe(1);
  });

  it("reports the most common weakness with a human label", async () => {
    const digest = await buildWeeklyDigest(db, repos, teamId);
    expect(digest?.topWeakness?.label).toBe("no output format");
    expect(digest?.topWeakness?.count).toBe(1);
  });

  it("lists top library prompts (title/score/usage only)", async () => {
    const digest = await buildWeeklyDigest(db, repos, teamId);
    expect(digest?.topPrompts[0]).toMatchObject({
      title: "Cold email opener",
      score: 88,
      usage: 0,
    });
  });

  it("returns null for a team with no activity this week", async () => {
    const digest = await buildWeeklyDigest(db, repos, quietTeamId);
    expect(digest).toBeNull();
  });

  it("treats a window boundary correctly (events at exactly 7d are last week)", async () => {
    await insertEvent({
      userId: managerId,
      anonId: "anon-boundary",
      score: 55,
      daysAgo: 7,
      at: new Date(Date.now() - WEEK_MS - 1),
    });
    const digest = await buildWeeklyDigest(db, repos, teamId);
    // The 7d-ago event lands in the PREVIOUS window (created_at < sinceThis),
    // so this-week count is unchanged at 5.
    expect(digest?.promptCount).toBe(5);
    expect(digest?.prevPromptCount).toBe(3);
  });
});

describe("runWeeklyDigest", () => {
  it("emails every manager of active teams and skips silent teams", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const summary = await runWeeklyDigest(
      { ...env, DEV_MODE: "false", SES_ACCESS_KEY_ID: "k", SES_SECRET_ACCESS_KEY: "s" },
      { send },
    );
    // 2 teams total; Quiet Corp has no data this week → skipped.
    expect(summary.teams).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.emails).toBe(1); // one manager on Acme Agency
    expect(summary.sent).toBe(1);
    expect(summary.dev).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const email = send.mock.calls[0]?.[1] as WeeklyDigestEmail;
    expect(email.to).toBe("rohan@example.com");
    expect(email.teamName).toBe("Acme Agency");
    expect(email.dashboardUrl).toBe("https://revealyst-web.pages.dev/team");
    expect(email.topWeakness).toContain("no output format");
  });

  it("logs instead of sending when SES is unavailable (dev mode)", async () => {
    const send = vi.fn();
    const summary = await runWeeklyDigest(env, { send });
    expect(summary.dev).toBe(true);
    expect(summary.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("buildWeeklyDigestHtml", () => {
  const email: WeeklyDigestEmail = {
    to: "rohan@example.com",
    teamName: "Acme <Agency>",
    periodLabel: "week ending Jun 16",
    avgScore: 74,
    prevAvgScore: 53,
    scoreDelta: 21,
    promptCount: 142,
    improvedCount: 5,
    comparedCount: 7,
    activeUsers: 8,
    topWeakness: "no output format (34 prompts)",
    topPrompts: [
      { title: "Cold email <opener>", score: 88, usage: 12 },
      { title: null, score: null, usage: 0 },
    ],
    dashboardUrl: "https://revealyst-web.pages.dev/team",
  };

  it("renders the KPIs, improvement and weakness", () => {
    const html = buildWeeklyDigestHtml(email);
    expect(html).toContain("Team average PQS");
    expect(html).toContain("74");
    expect(html).toContain("5 of 7");
    expect(html).toContain("no output format (34 prompts)");
    expect(html).toContain("▲ +21");
  });

  it("escapes user-derived content (team name, prompt titles)", () => {
    const html = buildWeeklyDigestHtml(email);
    expect(html).not.toContain("<Agency>");
    expect(html).toContain("Acme &lt;Agency&gt;");
    expect(html).toContain("Cold email &lt;opener&gt;");
  });

  it("handles a digest with no data gracefully", () => {
    const empty: WeeklyDigestEmail = {
      ...email,
      avgScore: null,
      prevAvgScore: null,
      scoreDelta: null,
      improvedCount: 0,
      comparedCount: 0,
      topWeakness: null,
      topPrompts: [],
    };
    const html = buildWeeklyDigestHtml(empty);
    expect(html).toContain("—");
    expect(html).toContain("Not enough data");
    expect(html).toContain("No prompts shared");
  });
});

void WEEK_MS;
