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

    async setRole(teamId: string, userId: string, role: "member" | "manager"): Promise<void> {
      await db.query("UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2", [
        teamId,
        userId,
        role,
      ]);
    },

    async setAnonAlias(teamId: string, userId: string, alias: string | null): Promise<void> {
      await db.query(
        "UPDATE team_members SET anon_alias = $3 WHERE team_id = $1 AND user_id = $2",
        [teamId, userId, alias],
      );
    },

    async isManager(teamId: string, userId: string): Promise<boolean> {
      const member = await this.findMember(teamId, userId);
      return member?.role === "manager";
    },
  };
}

export type TeamsRepo = ReturnType<typeof createTeamsRepo>;
