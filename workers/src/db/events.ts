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

export function createEventsRepo(db: SqlDb) {
  return {
    async insert(event: NewPromptEvent): Promise<void> {
      await db.query(
        `INSERT INTO prompt_events (user_id, user_anon_id, team_id, prompt_hash, score, breakdown, flags, llm_platform, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))`,
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
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;
