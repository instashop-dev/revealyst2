import type { SqlDb } from "@revealyst/db";
import type { TeamInviteRow } from "./schema.js";

/**
 * Team invite bookkeeping (db/migrations/005_team_invites.sql). Invites carry
 * a single-use magic link (jti in magic_link_tokens); the row records the
 * lifecycle so managers can list, re-send and revoke pending invites (§5.8).
 */
export function createInvitesRepo(db: SqlDb) {
  return {
    /** Insert a pending invite (or update the existing pending row for the
     *  same team+email — a re-invite refreshes the link instead of stacking
     *  duplicates). Returns the invite row that is now pending. */
    async upsertPending(
      teamId: string,
      email: string,
      role: string,
      invitedBy: string,
      jti: string,
      expiresAt: string,
    ): Promise<TeamInviteRow> {
      const existing = await this.findPendingByEmail(teamId, email);
      if (existing) {
        const { rows } = await db.query<TeamInviteRow>(
          `UPDATE team_invites
           SET role = $2, jti = $3, expires_at = $4, updated_at = now()
           WHERE id = $1 AND status = 'pending'
           RETURNING *`,
          [existing.id, role, jti, expiresAt],
        );
        const row = rows[0];
        if (!row) throw new Error("invite upsert returned no row");
        return row;
      }
      const { rows } = await db.query<TeamInviteRow>(
        `INSERT INTO team_invites (team_id, email, role, invited_by, status, jti, expires_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING *`,
        [teamId, email, role, invitedBy, jti, expiresAt],
      );
      const row = rows[0];
      if (!row) throw new Error("invite insert returned no row");
      return row;
    },

    /** Pending + recently-settled invites for a team (newest first). */
    async listByTeam(teamId: string): Promise<TeamInviteRow[]> {
      const { rows } = await db.query<TeamInviteRow>(
        "SELECT * FROM team_invites WHERE team_id = $1 ORDER BY created_at DESC",
        [teamId],
      );
      return rows;
    },

    async findById(id: string): Promise<TeamInviteRow | undefined> {
      const { rows } = await db.query<TeamInviteRow>(
        "SELECT * FROM team_invites WHERE id = $1 LIMIT 1",
        [id],
      );
      return rows[0];
    },

    async findPendingByEmail(teamId: string, email: string): Promise<TeamInviteRow | undefined> {
      const { rows } = await db.query<TeamInviteRow>(
        "SELECT * FROM team_invites WHERE team_id = $1 AND lower(email) = lower($2) AND status = 'pending' LIMIT 1",
        [teamId, email],
      );
      return rows[0];
    },

    /** Mark an invite accepted (the invitee verified the link). Guarded on
     *  'pending' so a concurrently revoked invite cannot be flipped back. */
    async markAccepted(id: string): Promise<void> {
      await db.query(
        "UPDATE team_invites SET status = 'accepted', jti = NULL, updated_at = now() WHERE id = $1 AND status = 'pending'",
        [id],
      );
    },

    /** Revoke a pending invite; returns the live jti so the caller can consume
     *  it (killing the magic link) — no-op when already settled. */
    async revoke(id: string): Promise<string | null> {
      const invite = await this.findById(id);
      if (!invite || invite.status !== "pending") return null;
      await db.query(
        `UPDATE team_invites
         SET status = 'revoked', jti = NULL, updated_at = now()
         WHERE id = $1`,
        [id],
      );
      return invite.jti;
    },

    /** Rotate the active link on a pending invite (re-send). */
    async rotateLink(
      id: string,
      jti: string,
      expiresAt: string,
    ): Promise<TeamInviteRow | undefined> {
      const { rows } = await db.query<TeamInviteRow>(
        `UPDATE team_invites
         SET jti = $2, expires_at = $3, updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [id, jti, expiresAt],
      );
      return rows[0];
    },
  };
}

export type InvitesRepo = ReturnType<typeof createInvitesRepo>;
