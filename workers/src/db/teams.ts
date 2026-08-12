import type { SqlDb } from "@revealyst/db";
import type { TeamMemberRow, TeamRow } from "./schema.js";

export function createTeamsRepo(db: SqlDb) {
  return {
    async create(name: string, createdBy: string): Promise<TeamRow> {
      const { rows } = await db.query<TeamRow>(
        "INSERT INTO teams (name, created_by) VALUES ($1, $2) RETURNING *",
        [name, createdBy],
      );
      const row = rows[0];
      if (!row) throw new Error("team insert returned no row");
      return row;
    },

    async findById(id: string): Promise<TeamRow | undefined> {
      const { rows } = await db.query<TeamRow>("SELECT * FROM teams WHERE id = $1 LIMIT 1", [id]);
      return rows[0];
    },

    /** Every team (weekly digest cron, admin tooling). */
    async listAll(): Promise<TeamRow[]> {
      const { rows } = await db.query<TeamRow>("SELECT * FROM teams ORDER BY created_at");
      return rows;
    },

    async listMembers(teamId: string): Promise<TeamMemberRow[]> {
      const { rows } = await db.query<TeamMemberRow>(
        "SELECT * FROM team_members WHERE team_id = $1 ORDER BY user_id",
        [teamId],
      );
      return rows;
    },

    async findMember(teamId: string, userId: string): Promise<TeamMemberRow | undefined> {
      const { rows } = await db.query<TeamMemberRow>(
        "SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1",
        [teamId, userId],
      );
      return rows[0];
    },

    async addMember(
      teamId: string,
      userId: string,
      role = "member",
      anonAlias?: string,
    ): Promise<void> {
      await db.query(
        "INSERT INTO team_members (team_id, user_id, role, anon_alias) VALUES ($1, $2, $3, $4)",
        [teamId, userId, role, anonAlias ?? null],
      );
    },

    async isManager(teamId: string, userId: string): Promise<boolean> {
      const member = await this.findMember(teamId, userId);
      return member?.role === "manager";
    },

    /** All teams the user belongs to, with their role in each (spec §5.5). */
    async listForUser(userId: string): Promise<Array<{ team: TeamRow; member: TeamMemberRow }>> {
      // Single JOIN — avoids the N+1 (one findById per membership) that made
      // /api/teams pay a query round trip for every team on page load.
      const { rows } = await db.query<
        TeamRow & {
          team_id: string;
          role: string;
          anon_alias: string | null;
          opt_in_identifiable: boolean;
        }
      >(
        `SELECT m.team_id, m.role, m.anon_alias, m.opt_in_identifiable, t.*
         FROM team_members m
         JOIN teams t ON t.id = m.team_id
         WHERE m.user_id = $1 ORDER BY m.team_id`,
        [userId],
      );
      return rows.map((r) => ({
        team: {
          id: r.id,
          name: r.name,
          created_by: r.created_by,
          billing_status: r.billing_status,
          settings: r.settings,
          created_at: r.created_at,
        },
        member: {
          team_id: r.team_id,
          user_id: userId,
          role: r.role,
          anon_alias: r.anon_alias,
          opt_in_identifiable: r.opt_in_identifiable,
        },
      }));
    },

    /** Members with their user emails (used only to derive display names in
     *  identifiable mode — emails themselves are never returned to clients). */
    async listMembersWithUsers(teamId: string): Promise<Array<TeamMemberRow & { email: string }>> {
      const { rows } = await db.query<TeamMemberRow & { email: string }>(
        `SELECT m.*, u.email FROM team_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.team_id = $1 ORDER BY u.email`,
        [teamId],
      );
      return rows;
    },

    /** Set the member's own identifiable-mode opt-in (spec §5.5). */
    async setOptIn(teamId: string, userId: string, enabled: boolean): Promise<void> {
      await db.query(
        "UPDATE team_members SET opt_in_identifiable = $3 WHERE team_id = $1 AND user_id = $2",
        [teamId, userId, enabled],
      );
    },

    /** True when every member has opted in to identifiable mode. */
    async allOptedIn(teamId: string): Promise<boolean> {
      const { rows } = await db.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM team_members WHERE team_id = $1 AND opt_in_identifiable = false",
        [teamId],
      );
      return Number(rows[0]?.n ?? 0) === 0;
    },

    /** Merge a partial settings patch into the team's JSONB settings. */
    async updateSettings(teamId: string, patch: Record<string, unknown>): Promise<TeamRow> {
      const team = await this.findById(teamId);
      if (!team) throw new Error("team settings update: team not found");
      const current =
        team.settings && typeof team.settings === "object"
          ? (team.settings as Record<string, unknown>)
          : {};
      const merged = { ...current, ...patch };
      // Assignment cast (text → jsonb) is implicit on UPDATE; the `||`
      // operator is avoided for pg-mem compatibility.
      // Pass the merged object (not a string) — postgres.js serializes it to
      // proper jsonb; a string would be stored as a jsonb string value and
      // come back as text, breaking `anonymize_identities` reads.
      const { rows } = await db.query<TeamRow>(
        "UPDATE teams SET settings = $2 WHERE id = $1 RETURNING *",
        [teamId, merged],
      );
      const row = rows[0];
      if (!row) throw new Error("team settings update returned no row");
      return row;
    },
  };
}

export type TeamsRepo = ReturnType<typeof createTeamsRepo>;
