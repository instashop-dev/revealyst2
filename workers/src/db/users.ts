import type { SqlDb } from "@revealyst/db";
import type { UserRow } from "./schema.js";

export interface AdminUserRow {
  id: string;
  email: string;
  plan: string;
  created_at: string;
  /** Number of synced prompt events attributed to this user (user_id match). */
  events_count: number;
  /** Most recent prompt event timestamp, or null when the user has none. */
  last_active_at: string | null;
}

export interface TeamMembershipRow {
  user_id: string;
  team_id: string;
  team_name: string;
  role: string;
}

export function createUsersRepo(db: SqlDb) {
  return {
    async findByEmail(email: string): Promise<UserRow | undefined> {
      const { rows } = await db.query<UserRow>("SELECT * FROM users WHERE email = $1 LIMIT 1", [
        email,
      ]);
      return rows[0];
    },

    async getById(id: string): Promise<UserRow | undefined> {
      const { rows } = await db.query<UserRow>("SELECT * FROM users WHERE id = $1 LIMIT 1", [id]);
      return rows[0];
    },

    async create(email: string): Promise<UserRow> {
      const { rows } = await db.query<UserRow>(
        "INSERT INTO users (email) VALUES ($1) RETURNING *",
        [email],
      );
      const row = rows[0];
      if (!row) throw new Error("user insert returned no row");
      return row;
    },

    /**
     * Every signed-up user with MVP admin details, newest first: plan, signup
     * date, prompt-event volume and last activity (both derived from the
     * anonymised prompt_events table — no raw prompt data is exposed).
     */
    async listAll(): Promise<AdminUserRow[]> {
      const { rows } = await db.query<{
        id: string;
        email: string;
        plan: string;
        created_at: string;
        events_count: string;
        last_active_at: string | null;
      }>(
        `SELECT u.id, u.email, u.plan, u.created_at,
                COUNT(pe.id)::int AS events_count,
                MAX(pe.created_at) AS last_active_at
         FROM users u
         LEFT JOIN prompt_events pe ON pe.user_id = u.id
         GROUP BY u.id, u.email, u.plan, u.created_at
         ORDER BY u.created_at DESC`,
      );
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        plan: row.plan,
        created_at: row.created_at,
        events_count: Number(row.events_count ?? 0),
        last_active_at: row.last_active_at,
      }));
    },

    /** All team memberships joined with team names (admin users list). */
    async listTeamMemberships(): Promise<TeamMembershipRow[]> {
      const { rows } = await db.query<TeamMembershipRow>(
        `SELECT m.user_id, t.id AS team_id, t.name AS team_name, m.role
         FROM team_members m
         JOIN teams t ON t.id = m.team_id
         ORDER BY t.name`,
      );
      return rows;
    },
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;
