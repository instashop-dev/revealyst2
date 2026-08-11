import type { WorkerEnv } from "./env.js";
import { getDb, closeRequestDb } from "./db.js";
import { createRepos } from "./db/index.js";
import type { Repos } from "./db/index.js";
import type { SqlDb } from "@revealyst/db";
import type { SesConfig } from "./email.js";
import { sendWeeklyDigestEmail, type WeeklyDigestEmail } from "./email.js";

/**
 * Weekly manager digest (MVP: the one feature that drives manager retention).
 *
 * Every Monday a cron trigger calls `runWeeklyDigest`: for each team with
 * prompt activity in the last 7 days, aggregate this week vs the previous
 * week and email the managers a report — team average PQS with the week-over-
 * week delta, member improvement, the most common weakness, and top saved
 * prompts.
 *
 * Privacy: the digest is computed from the same anonymised data as the team
 * dashboard — scores, hashes and aggregates only. Raw prompt text never
 * leaves the extension, and the digest never contains it.
 */

export const WEEK_MS = 7 * 86_400_000;

/** Weekly aggregation for one team (this week vs the previous 7 days). */
export interface TeamWeeklyDigest {
  teamId: string;
  teamName: string;
  /** e.g. "week ending Jun 16" */
  periodLabel: string;
  avgScore: number | null;
  prevAvgScore: number | null;
  scoreDelta: number | null;
  promptCount: number;
  prevPromptCount: number;
  /** Distinct members with ≥1 prompt this week. */
  activeUsers: number;
  /** Members with events in BOTH windows whose average improved. */
  improvedCount: number;
  /** Members with events in BOTH windows (the denominator). */
  comparedCount: number;
  /** Most frequent deficiency flag this week, human-readable. */
  topWeakness: { label: string; count: number } | null;
  /** Top-scored library prompts (title/score/usage only). */
  topPrompts: Array<{ title: string | null; score: number | null; usage: number }>;
}

export interface DigestRunSummary {
  /** Teams processed (with data in the last 7 days). */
  teams: number;
  /** Digest emails generated (one per manager of a processed team). */
  emails: number;
  /** Emails actually delivered via SES (0 when dev/log-only mode). */
  sent: number;
  /** Teams skipped: no activity this week or no manager on record. */
  skipped: number;
  /** Per-team error messages (a failing team never blocks the others). */
  errors: string[];
  /** True when SES was unavailable — nothing was delivered, only logged. */
  dev: boolean;
}

const FLAG_LABELS: Record<string, string> = {
  low_specificity: "vague prompts (add specifics)",
  vague_context: "missing context (who it is for, why)",
  missing_context: "missing context (who it is for, why)",
  missing_role: "no role defined",
  missing_output_format: "no output format",
  no_examples: "no examples",
  too_short: "very short prompts",
  too_long: "very long prompts",
};

function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] ?? flag.replace(/_/g, " ");
}

function periodLabel(now: Date): string {
  return `week ending ${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

interface WindowEvents {
  /** user_anon_id → average score in the window */
  byUser: Map<string, { sum: number; n: number }>;
  count: number;
  avgScore: number | null;
}

function aggregateWindow(
  rows: Array<{ user_anon_id: string; score: number | null }>,
): WindowEvents {
  const byUser = new Map<string, { sum: number; n: number }>();
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    if (row.score == null) continue;
    const agg = byUser.get(row.user_anon_id) ?? { sum: 0, n: 0 };
    agg.sum += row.score;
    agg.n += 1;
    byUser.set(row.user_anon_id, agg);
    sum += row.score;
    n += 1;
  }
  return { byUser, count: n, avgScore: n > 0 ? Math.round(sum / n) : null };
}

/**
 * Aggregate one team's digest for the current 7-day window vs the previous
 * one. Returns null when the team has no events this week (nothing to report).
 */
export async function buildWeeklyDigest(
  db: SqlDb,
  repos: Repos,
  teamId: string,
  now: Date = new Date(),
): Promise<TeamWeeklyDigest | null> {
  const sinceThis = new Date(now.getTime() - WEEK_MS).toISOString();
  const sincePrev = new Date(now.getTime() - 2 * WEEK_MS).toISOString();

  const team = await repos.teams.findById(teamId);
  if (!team) return null;

  const [thisRows, prevRows] = await Promise.all([
    db.query<{ user_anon_id: string; score: number | null }>(
      `SELECT user_anon_id, score FROM prompt_events WHERE team_id = $1 AND created_at >= $2`,
      [teamId, sinceThis],
    ),
    db.query<{ user_anon_id: string; score: number | null }>(
      `SELECT user_anon_id, score FROM prompt_events WHERE team_id = $1 AND created_at >= $2 AND created_at < $3`,
      [teamId, sincePrev, sinceThis],
    ),
  ]);

  const thisWeek = aggregateWindow(thisRows.rows);
  const prevWeek = aggregateWindow(prevRows.rows);
  if (thisWeek.count === 0) return null;

  // Members with events in BOTH windows whose average went up.
  let improved = 0;
  let compared = 0;
  for (const [user, cur] of thisWeek.byUser) {
    const prev = prevWeek.byUser.get(user);
    if (!prev) continue;
    compared += 1;
    if (cur.sum / cur.n > prev.sum / prev.n) improved += 1;
  }

  const weaknesses = await repos.events.commonWeaknesses(teamId, sinceThis);
  const topWeakness = weaknesses[0]
    ? { label: flagLabel(weaknesses[0].flag), count: weaknesses[0].count }
    : null;

  const top = await repos.library.topForTeam(teamId, 3);

  return {
    teamId,
    teamName: team.name,
    periodLabel: periodLabel(now),
    avgScore: thisWeek.avgScore,
    prevAvgScore: prevWeek.avgScore,
    scoreDelta:
      thisWeek.avgScore != null && prevWeek.avgScore != null
        ? thisWeek.avgScore - prevWeek.avgScore
        : null,
    promptCount: thisWeek.count,
    prevPromptCount: prevWeek.count,
    activeUsers: thisWeek.byUser.size,
    improvedCount: improved,
    comparedCount: compared,
    topWeakness,
    topPrompts: top.map((p) => ({
      title: p.title,
      score: p.score,
      usage: p.usage_count,
    })),
  };
}

function digestEmail(digest: TeamWeeklyDigest, to: string, appUrl: string): WeeklyDigestEmail {
  return {
    to,
    teamName: digest.teamName,
    periodLabel: digest.periodLabel,
    avgScore: digest.avgScore,
    prevAvgScore: digest.prevAvgScore,
    scoreDelta: digest.scoreDelta,
    promptCount: digest.promptCount,
    improvedCount: digest.improvedCount,
    comparedCount: digest.comparedCount,
    activeUsers: digest.activeUsers,
    topWeakness: digest.topWeakness
      ? `${digest.topWeakness.label} (${digest.topWeakness.count} prompts)`
      : null,
    topPrompts: digest.topPrompts,
    dashboardUrl: `${appUrl}/team`,
  };
}

export interface DigestDeps {
  /** Send hook (defaults to the real SES sender). Tests inject a spy. */
  send?: (config: SesConfig, email: WeeklyDigestEmail) => Promise<void>;
}

/**
 * Run the weekly digest for every team: aggregate, then email each manager.
 * Per-team failures are logged and never block the other teams. The digest
 * only emails teams that scored at least one prompt this week — silent teams
 * get no noise.
 *
 * SES availability: with no SES keys (or DEV_MODE), the digest is logged and
 * counted but nothing is delivered — local dev and CI behave the same.
 */
export async function runWeeklyDigest(
  env: WorkerEnv,
  deps: DigestDeps = {},
): Promise<DigestRunSummary> {
  const summary: DigestRunSummary = {
    teams: 0,
    emails: 0,
    sent: 0,
    skipped: 0,
    errors: [],
    dev: false,
  };
  const send = deps.send ?? sendWeeklyDigestEmail;
  const sesAvailable = Boolean(env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY);
  const devMode = env.DEV_MODE === "true";
  summary.dev = !sesAvailable || devMode;

  const config: SesConfig | null = sesAvailable
    ? {
        region: env.SES_REGION ?? "us-east-1",
        accessKeyId: env.SES_ACCESS_KEY_ID as string,
        secretAccessKey: env.SES_SECRET_ACCESS_KEY as string,
        fromEmail: env.SES_FROM_EMAIL ?? "Revealyst <noreply@e.revealyst.com>",
      }
    : null;

  let db;
  try {
    db = await getDb(env);
    const repos = createRepos(db);
    const teams = await repos.teams.listAll();
    summary.teams = teams.length;

    for (const team of teams) {
      try {
        const digest = await buildWeeklyDigest(db, repos, team.id);
        if (!digest) {
          summary.skipped += 1;
          continue;
        }
        const managers = (await repos.teams.listMembersWithUsers(team.id)).filter(
          (m) => m.role === "manager",
        );
        if (managers.length === 0) {
          summary.skipped += 1;
          continue;
        }
        for (const manager of managers) {
          const email = digestEmail(digest, manager.email, env.APP_URL);
          summary.emails += 1;
          if (config && !devMode) {
            await send(config, email);
            summary.sent += 1;
          } else {
            console.log(
              `[digest] ${devMode ? "dev" : "no-SES"} digest for ${manager.email} (${digest.teamName}): avg ${digest.avgScore ?? "—"} (${digest.prevAvgScore ?? "—"} prev), ${digest.promptCount} prompts, ${digest.improvedCount}/${digest.comparedCount} improved`,
            );
          }
        }
      } catch (err) {
        // Sanitize before echoing into the admin summary — SES error bodies
        // can contain arbitrary upstream text; strip control chars + truncate.
        const safe = String((err as Error).message)
          .replace(/\p{Cc}/gu, " ")
          .trim()
          .slice(0, 300);
        const message = `team ${team.id}: ${safe || "unknown error"}`;
        console.error(`[digest] failed for ${message}`);
        summary.errors.push(message);
      }
    }
  } finally {
    if (db) await closeRequestDb(env);
  }
  return summary;
}
