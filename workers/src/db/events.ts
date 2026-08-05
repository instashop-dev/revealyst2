import type { SqlDb } from "@revealyst/db";
import type { PromptEventRow } from "./schema.js";

export interface NewPromptEvent {
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
  avgScore7d: number | null;
  commonWeaknesses: Array<{ flag: string; count: number }>;
  topPrompts: Array<{ prompt_hash: string; best_score: number; occurrences: number }>;
  volumeByPlatform: Array<{ llm_platform: string | null; count: number }>;
  volumeByDay: Array<{ day: string; count: number }>;
  trendByUser: Array<{ user_anon_id: string; day: string; avg_score: number }>;
}

export function createEventsRepo(db: SqlDb) {
  return {
    async insert(event: NewPromptEvent): Promise<void> {
      await db.query(
        `INSERT INTO prompt_events (user_anon_id, team_id, prompt_hash, score, breakdown, flags, llm_platform, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))`,
        [
          event.userAnonId,
          event.teamId,
          event.promptHash,
          event.score,
          JSON.stringify(event.breakdown),
          event.flags,
          event.llmPlatform,
          event.createdAt ?? null,
        ],
      );
    },

    async userHistory(userAnonId: string, sinceIso: string): Promise<PromptEventRow[]> {
      const { rows } = await db.query<PromptEventRow>(
        "SELECT * FROM prompt_events WHERE user_anon_id = $1 AND created_at >= $2 ORDER BY created_at DESC",
        [userAnonId, sinceIso],
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
      const [volumeByDay, trendByUser] = await this.temporal(teamId, sinceIso);

      return {
        avgScore7d: avg.rows[0]?.avg == null ? null : Math.round(Number(avg.rows[0].avg)),
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

    /** Volume-per-day and per-user trend computed without date casts (portable). */
    async temporal(
      teamId: string,
      sinceIso: string,
    ): Promise<
      [
        Array<{ day: string; count: number }>,
        Array<{ user_anon_id: string; day: string; avg_score: number }>,
      ]
    > {
      const { rows } = await db.query<{
        user_anon_id: string;
        created_at: string | Date;
        score: number | null;
      }>(
        "SELECT user_anon_id, created_at, score FROM prompt_events WHERE team_id = $1 AND created_at >= $2",
        [teamId, sinceIso],
      );
      const dayOf = (v: string | Date): string =>
        v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

      const byDay = new Map<string, number>();
      const byUser = new Map<string, Map<string, { sum: number; n: number }>>();
      for (const row of rows) {
        const day = dayOf(row.created_at);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
        if (row.score != null) {
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

      const trendByUser = [...byUser.entries()]
        .flatMap(([user, days]) =>
          [...days.entries()].map(([day, agg]) => ({
            user_anon_id: user,
            day,
            avg_score: Math.round(agg.sum / agg.n),
          })),
        )
        .sort((a, b) => a.user_anon_id.localeCompare(b.user_anon_id) || a.day.localeCompare(b.day));

      return [volumeByDay, trendByUser];
    },
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;
