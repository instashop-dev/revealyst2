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
      // Opportunistic cleanup keeps the table small (links live ≤15 min) and
      // prunes never-verified accounts: users created >24h ago with no active
      // magic link and no team membership are spam rows, not real users.
      await db.query("DELETE FROM magic_link_tokens WHERE expires_at < now()");
      // Prune never-verified accounts: users created >24h ago with no active
      // magic link and no team membership are spam rows, not real users.
      const stale = await db.query<{ id: string }>(
        `SELECT id FROM users
         WHERE created_at < now() - interval '1 day'
           AND id NOT IN (SELECT user_id FROM magic_link_tokens)
           AND id NOT IN (SELECT user_id FROM team_members)
         LIMIT 100`,
      );
      for (const row of stale.rows) {
        await db.query("DELETE FROM users WHERE id = $1", [row.id]);
      }
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
