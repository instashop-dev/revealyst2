import type { SqlDb } from "@revealyst/db";
import type { UserRow } from "./schema.js";

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
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;
