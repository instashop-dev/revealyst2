import type { SqlDb } from "@revealyst/db";

export function createFeedbackRepo(db: SqlDb) {
  return {
    async insert(userId: string, suggestionId: string, wasAccepted: boolean): Promise<void> {
      await db.query(
        "INSERT INTO suggestions_feedback (user_id, suggestion_id, was_accepted) VALUES ($1, $2, $3)",
        [userId, suggestionId, wasAccepted],
      );
    },

    /** Count of accepted suggestions for the personal dashboard (spec §5.4). */
    async countAccepted(userId: string): Promise<number> {
      const { rows } = await db.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM suggestions_feedback WHERE user_id = $1 AND was_accepted = true",
        [userId],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type FeedbackRepo = ReturnType<typeof createFeedbackRepo>;
