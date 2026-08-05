import type { SqlDb } from "@revealyst/db";

export function createFeedbackRepo(db: SqlDb) {
  return {
    async insert(userId: string, suggestionId: string, wasAccepted: boolean): Promise<void> {
      await db.query(
        "INSERT INTO suggestions_feedback (user_id, suggestion_id, was_accepted) VALUES ($1, $2, $3)",
        [userId, suggestionId, wasAccepted],
      );
    },
  };
}

export type FeedbackRepo = ReturnType<typeof createFeedbackRepo>;
