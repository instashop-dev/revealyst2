import type { SqlDb } from "@revealyst/db";

/**
 * Single-use magic-link bookkeeping (db/migrations/002_magic_links.sql).
 * A jti row is written when the magic link is sent and deleted when the link
 * is first verified, which makes replay impossible even across Worker
 * isolates. Expired rows are swept opportunistically on insert.
 */
export function createMagicRepo(db: SqlDb) {
  return {
    async insert(jti: string, userId: string, expiresAt: string): Promise<void> {
      // Opportunistic cleanup keeps the table small (links live ≤15 min).
      // NOTE: unverified-user pruning is intentionally NOT done here — inline
      // deletes can hit FK rows (feedback/library) or active users with
      // consumed links (no sessions table), so it needs a careful scheduled
      // job (see docs/runbook.md — known hardening item).
      await db.query("DELETE FROM magic_link_tokens WHERE expires_at < now()");
      await db.query(
        "INSERT INTO magic_link_tokens (jti, user_id, expires_at) VALUES ($1, $2, $3)",
        [jti, userId, expiresAt],
      );
    },

    /** Atomically consume a jti; true only if it existed and was unused. */
    async consume(jti: string): Promise<boolean> {
      const { rows } = await db.query<{ jti: string }>(
        "DELETE FROM magic_link_tokens WHERE jti = $1 RETURNING jti",
        [jti],
      );
      return rows.length > 0;
    },
  };
}

export type MagicRepo = ReturnType<typeof createMagicRepo>;
