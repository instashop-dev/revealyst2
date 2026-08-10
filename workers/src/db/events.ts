import type { SqlDb } from "@revealyst/db";
import type { PromptEventRow } from "./schema.js";

export interface NewPromptEvent {
  /** Authenticated user id (nullable for anonymous events). */
  userId: string | null;
  userAnonId: string;
  teamId: string | null;
  promptHash: string;
  score: number;
  breakdown: Record<string, number>;
  flags: string[];
  llmPlatform: string | null;
  /** Thumbs up/down for this prompt (-1 | 0 | 1). Null = not rated. */
  rating?: number | null;
  /** Optional explicit timestamp (tests). Defaults to now(). */
  createdAt?: string;
}

export interface TeamStats {
  avgScore: number | null;
  commonWeaknesses: Array<{ flag: string; count: number }>;
  topPrompts: Array<{ prompt_hash: string; best_score: number; occurrences: number }>;
  volumeByPlatform: Array<{ llm_platform: string | null; count: number }>;
  volumeByDay: Array<{ day: string; count: number }>;
  avgScoreByDay: Array<{ day: string; avg_score: number }>;
  trendByUser: Array<{
    user_anon_id: string;
    user_id: string | null;
    day: string;
    avg_score: number;
  }>;
}

export interface PersonalStats {
  period: string;
  promptsCount: number;
  greenCount: number;
  avgScore: number | null;
  acceptedCount: number;
  clarityCount: number;
  formatCount: number;
  streakDays: number;
  trend: Array<{ day: string; avg_score: number }>;
  radar: Record<string, number>;
}

/**
 * North-star instrumentation (spec §4): 4-week PQS lift, re-prompt rate and
 * weekly retention, derived from the user's own (anonymised) events.
 */
export interface PersonalImprovement {
  /** Current 7-day avg minus the 7-day avg 21-28 days ago. Null when either
   *  window has no events (the user is newer than 4 weeks). */
  pqsDelta4w: number | null;
  currentAvg: number | null;
  baselineAvg: number | null;
  /** Share of events whose prompt_hash was seen earlier in the last 30 days.
   *  The extension dedupes consecutive repeats, so this is genuine re-use. */
  repromptRate: number | null;
  /** Same metric for the previous 30-day window (for the reduction delta). */
  repromptRatePrev: number | null;
  /** Of the last 4 (7-day) buckets, how many contain ≥1 event. */
  activeWeeks: number;
}

export function createEventsRepo(db: SqlDb) {
  return {
    async insert(event: NewPromptEvent): Promise<void> {
      await db.query(
        `INSERT INTO prompt_events (user_id, user_anon_id, team_id, prompt_hash, score, breakdown, flags, llm_platform, rating, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()))`,
        [
          event.userId,
          event.userAnonId,
          event.teamId,
          event.promptHash,
          event.score,
          // Pass the object (not a string): postgres.js serializes JS objects
          // to proper jsonb; a string would be stored as a jsonb *string*
          // value and come back as text, breaking radar/stats reads.
          event.breakdown,
          event.flags,
          event.llmPlatform,
          event.rating ?? null,
          event.createdAt ?? null,
        ],
      );
    },

    /** The authenticated user's own events (personal dashboard, spec §5.4). */
    async userHistory(
      userId: string,
      sinceIso: string,
      filters: { platform?: string; minScore?: number; limit?: number } = {},
    ): Promise<PromptEventRow[]> {
      const conditions = ["user_id = $1", "created_at >= $2"];
      const params: unknown[] = [userId, sinceIso];
      let i = 3;
      if (filters.platform) {
        conditions.push(`llm_platform = $${i}`);
        params.push(filters.platform);
        i += 1;
      }
      if (filters.minScore !== undefined) {
        conditions.push(`score >= $${i}`);
        params.push(filters.minScore);
      }
      const { rows } = await db.query<PromptEventRow>(
        `SELECT * FROM prompt_events WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC LIMIT ${Math.min(200, filters.limit ?? 100)}`,
        params,
      );
      return rows;
    },

    /**
     * Aggregated, anonymised team statistics (spec §5.5). Individual prompts
     * are never returned — only hashes, aggregates and pseudonymous user ids.
     *
     * Where pg-mem lacks SQL features (unnest, date casts) the aggregation
     * transparently falls back to in-JS grouping; production Postgres always
     * takes the SQL path.
     */
    async teamStats(teamId: string, sinceIso: string): Promise<TeamStats> {
      const [avg, platforms, top] = await Promise.all([
        db.query<{ avg: number | string | null }>(
          "SELECT AVG(score) AS avg FROM prompt_events WHERE team_id = $1 AND created_at >= $2",
          [teamId, sinceIso],
        ),
        db.query<{ llm_platform: string | null; count: number | string }>(
          "SELECT llm_platform, COUNT(*) AS count FROM prompt_events WHERE team_id = $1 AND created_at >= $2 GROUP BY llm_platform ORDER BY count DESC",
          [teamId, sinceIso],
        ),
        db.query<{
          prompt_hash: string;
          best_score: number | string;
          occurrences: number | string;
        }>(
          `SELECT prompt_hash, MAX(score) AS best_score, COUNT(*) AS occurrences
           FROM prompt_events WHERE team_id = $1 AND created_at >= $2
           GROUP BY prompt_hash ORDER BY best_score DESC LIMIT 10`,
          [teamId, sinceIso],
        ),
      ]);

      const weaknesses = await this.commonWeaknesses(teamId, sinceIso);
      const [volumeByDay, trendByUser, avgScoreByDay] = await this.temporal(teamId, sinceIso);

      return {
        avgScore: avg.rows[0]?.avg == null ? null : Math.round(Number(avg.rows[0].avg)),
        commonWeaknesses: weaknesses,
        topPrompts: top.rows.map((r) => ({
          prompt_hash: r.prompt_hash,
          best_score: Number(r.best_score),
          occurrences: Number(r.occurrences),
        })),
        volumeByPlatform: platforms.rows.map((r) => ({
          llm_platform: r.llm_platform,
          count: Number(r.count),
        })),
        volumeByDay,
        avgScoreByDay,
        trendByUser,
      };
    },

    /** Flag frequency across the window. SQL unnest on Postgres, JS fallback elsewhere. */
    async commonWeaknesses(
      teamId: string,
      sinceIso: string,
    ): Promise<Array<{ flag: string; count: number }>> {
      try {
        const { rows } = await db.query<{ flag: string; count: number | string }>(
          `SELECT flag, COUNT(*) AS count FROM prompt_events, unnest(flags) AS flag
           WHERE team_id = $1 AND created_at >= $2 GROUP BY flag ORDER BY count DESC LIMIT 10`,
          [teamId, sinceIso],
        );
        return rows.map((r) => ({ flag: r.flag, count: Number(r.count) }));
      } catch {
        const { rows } = await db.query<{ flags: string[] | null }>(
          "SELECT flags FROM prompt_events WHERE team_id = $1 AND created_at >= $2",
          [teamId, sinceIso],
        );
        const counts = new Map<string, number>();
        for (const row of rows) {
          for (const flag of row.flags ?? []) {
            counts.set(flag, (counts.get(flag) ?? 0) + 1);
          }
        }
        return [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([flag, count]) => ({ flag, count }));
      }
    },

    /** Volume-per-day, avg-score-per-day and per-user trend (portable). */
    async temporal(
      teamId: string,
      sinceIso: string,
    ): Promise<
      [
        Array<{ day: string; count: number }>,
        Array<{ user_anon_id: string; user_id: string | null; day: string; avg_score: number }>,
        Array<{ day: string; avg_score: number }>,
      ]
    > {
      const { rows } = await db.query<{
        user_anon_id: string;
        user_id: string | null;
        created_at: string | Date;
        score: number | null;
      }>(
        "SELECT user_anon_id, user_id, created_at, score FROM prompt_events WHERE team_id = $1 AND created_at >= $2",
        [teamId, sinceIso],
      );
      const dayOf = (v: string | Date): string =>
        v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

      const byDay = new Map<string, number>();
      const scoreByDay = new Map<string, { sum: number; n: number }>();
      const byUser = new Map<string, Map<string, { sum: number; n: number }>>();
      for (const row of rows) {
        const day = dayOf(row.created_at);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
        if (row.score != null) {
          const aggDay = scoreByDay.get(day) ?? { sum: 0, n: 0 };
          aggDay.sum += row.score;
          aggDay.n += 1;
          scoreByDay.set(day, aggDay);

          const days =
            byUser.get(row.user_anon_id) ?? new Map<string, { sum: number; n: number }>();
          const agg = days.get(day) ?? { sum: 0, n: 0 };
          agg.sum += row.score;
          agg.n += 1;
          days.set(day, agg);
          byUser.set(row.user_anon_id, days);
        }
      }

      const volumeByDay = [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, count]) => ({ day, count }));

      const avgScoreByDay = [...scoreByDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, agg]) => ({ day, avg_score: Math.round(agg.sum / agg.n) }));

      const trendByUser = [...byUser.entries()]
        .flatMap(([user, days]) =>
          [...days.entries()].map(([day, agg]) => ({
            user_anon_id: user,
            user_id: rows.find((r) => r.user_anon_id === user)?.user_id ?? null,
            day,
            avg_score: Math.round(agg.sum / agg.n),
          })),
        )
        .sort((a, b) => a.user_anon_id.localeCompare(b.user_anon_id) || a.day.localeCompare(b.day));

      return [volumeByDay, trendByUser, avgScoreByDay];
    },

    /**
     * Personal dashboard statistics from the user's own events (spec §5.4):
     * trend, radar averages, counts, and streaks. Computed in JS for
     * portability across pg-mem and Postgres.
     */
    async personalStats(userId: string, periodDays = 30): Promise<PersonalStats> {
      const since = new Date(Date.now() - periodDays * 86_400_000).toISOString();
      const { rows } = await db.query<{
        score: number | null;
        breakdown: Record<string, number> | string | null;
        created_at: string | Date;
      }>(
        "SELECT score, breakdown, created_at FROM prompt_events WHERE user_id = $1 AND created_at >= $2",
        [userId, since],
      );

      const dayOf = (v: string | Date): string =>
        v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
      const parse = (b: Record<string, number> | string | null): Record<string, number> => {
        if (!b) return {};
        return typeof b === "string" ? (JSON.parse(b) as Record<string, number>) : b;
      };

      const dimSums = new Map<string, { sum: number; n: number }>();
      const dayScores = new Map<string, { sum: number; n: number }>();
      const scoredDays = new Set<string>();
      let total = 0;
      let green = 0;
      let clarity = 0;
      let format = 0;

      for (const row of rows) {
        total += 1;
        const day = dayOf(row.created_at);
        scoredDays.add(day);
        if (row.score != null) {
          const agg = dayScores.get(day) ?? { sum: 0, n: 0 };
          agg.sum += row.score;
          agg.n += 1;
          dayScores.set(day, agg);
          if (row.score >= 70) green += 1;
        }
        for (const [dim, value] of Object.entries(parse(row.breakdown))) {
          const agg = dimSums.get(dim) ?? { sum: 0, n: 0 };
          agg.sum += value;
          agg.n += 1;
          dimSums.set(dim, agg);
        }
        const b = parse(row.breakdown);
        if (b.role_clarity != null && b.role_clarity > 80) clarity += 1;
        if (b.output_format != null && b.output_format >= 50) format += 1;
      }

      const radar: Record<string, number> = {};
      for (const [dim, agg] of dimSums) {
        radar[dim] = Math.round(agg.sum / agg.n);
      }

      const trend = [...dayScores.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, agg]) => ({ day, avg_score: Math.round(agg.sum / agg.n) }));

      // Streak: consecutive days with ≥1 event, ending today or yesterday.
      let streak = 0;
      const days = [...scoredDays].sort();
      const cursor = new Date();
      // Start from today; if today has no events, a streak may still run from
      // yesterday (the user hasn't scored yet today).
      if (!days.includes(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1);
      const daySet = new Set(days);
      while (daySet.has(cursor.toISOString().slice(0, 10))) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
      }

      return {
        period: `${periodDays}d`,
        promptsCount: total,
        greenCount: green,
        avgScore:
          total > 0
            ? Math.round(
                (dayScores.size > 0 ? [...dayScores.values()].reduce((s, a) => s + a.sum, 0) : 0) /
                  total,
              )
            : null,
        acceptedCount: 0, // filled by the stats route from the feedback repo
        clarityCount: clarity,
        formatCount: format,
        streakDays: streak,
        trend,
        radar,
      };
    },

    /**
     * North-star metrics (spec §4) from the user's own events: the 4-week PQS
     * lift (current 7d avg vs the 7d avg 21-28 days ago), the re-prompt rate
     * for the current and previous 30-day windows, and active weeks out of the
     * last 4. Computed in JS (portable across pg-mem and Postgres).
     */
    async personalImprovement(userId: string): Promise<PersonalImprovement> {
      const day = 86_400_000;
      const now = Date.now();
      const since30 = new Date(now - 30 * day).toISOString();
      const { rows } = await db.query<{
        score: number | null;
        prompt_hash: string;
        created_at: string | Date;
      }>(
        "SELECT score, prompt_hash, created_at FROM prompt_events WHERE user_id = $1 AND created_at >= $2",
        [userId, since30],
      );
      const ts = (v: string | Date): number =>
        v instanceof Date ? v.getTime() : Date.parse(String(v));

      // 4-week lift: average score in the current 7-day window vs the window
      // 21-28 days ago. Both must be non-empty, else null (too new to judge).
      const inWindow = (t: number, fromDays: number, toDays: number): boolean => {
        const from = now - fromDays * day;
        const to = now - toDays * day;
        return t >= from && t < to;
      };
      let curSum = 0;
      let curN = 0;
      let baseSum = 0;
      let baseN = 0;
      for (const r of rows) {
        if (r.score == null) continue;
        const t = ts(r.created_at);
        if (inWindow(t, 7, 0)) {
          curSum += r.score;
          curN += 1;
        } else if (inWindow(t, 28, 21)) {
          baseSum += r.score;
          baseN += 1;
        }
      }
      const currentAvg = curN > 0 ? Math.round(curSum / curN) : null;
      const baselineAvg = baseN > 0 ? Math.round(baseSum / baseN) : null;
      // Round once on the raw averages, not on the rounded pair (keeps the
      // delta stable when both averages land on .5 boundaries).
      const pqsDelta4w = curN > 0 && baseN > 0 ? Math.round(curSum / curN - baseSum / baseN) : null;

      // Re-prompt rate: an event whose prompt_hash was seen earlier in the
      // window counts as a re-prompt. Previous window: the 30 days before the
      // current 30 days.
      const since60 = new Date(now - 60 * day).toISOString();
      const { rows: older } = await db.query<{
        prompt_hash: string;
        created_at: string | Date;
      }>(
        "SELECT prompt_hash, created_at FROM prompt_events WHERE user_id = $1 AND created_at >= $2 AND created_at < $3",
        [userId, since60, since30],
      );
      const repeatRate = (events: Array<{ prompt_hash: string }>): number | null => {
        if (events.length === 0) return null;
        const seen = new Set<string>();
        let repeated = 0;
        for (const e of events) {
          if (seen.has(e.prompt_hash)) repeated += 1;
          seen.add(e.prompt_hash);
        }
        return Math.round((repeated / events.length) * 1000) / 1000;
      };

      // Active weeks: distinct 7-day buckets (of the last 4) with ≥1 event.
      const active = new Set<number>();
      for (const r of rows) {
        const bucket = Math.floor((now - ts(r.created_at)) / (7 * day));
        if (bucket >= 0 && bucket < 4) active.add(bucket);
      }

      return {
        pqsDelta4w,
        currentAvg,
        baselineAvg,
        repromptRate: repeatRate(rows),
        repromptRatePrev: repeatRate(older),
        activeWeeks: active.size,
      };
    },
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;
