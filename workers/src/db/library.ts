import type { SqlDb } from "@revealyst/db";
import type { LibraryPromptRow } from "./schema.js";

export interface NewLibraryPrompt {
  teamId: string;
  title: string | null;
  /** hex(iv || AES-256-GCM ciphertext) of the plaintext prompt. */
  encryptedPrompt: string;
  promptHash: string; // SHA-256 of the plaintext prompt — dedup key
  tags: string[];
  createdBy: string;
  score: number;
}

export interface LibraryFilters {
  search?: string;
  tag?: string;
  minScore?: number;
  page?: number;
  pageSize?: number;
}

export function createLibraryRepo(db: SqlDb) {
  return {
    async insert(prompt: NewLibraryPrompt): Promise<LibraryPromptRow> {
      const { rows } = await db.query<LibraryPromptRow>(
        `INSERT INTO library_prompts (team_id, title, prompt_text_encrypted, prompt_hash, tags, created_by, score)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          prompt.teamId,
          prompt.title,
          prompt.encryptedPrompt,
          prompt.promptHash,
          prompt.tags,
          prompt.createdBy,
          prompt.score,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("library insert returned no row");
      return row;
    },

    /**
     * List team library prompts. Search matches title/tags only — encrypted
     * prompt bodies are never scanned (privacy by design).
     */
    async list(
      teamId: string,
      filters: LibraryFilters = {},
    ): Promise<{ prompts: LibraryPromptRow[]; total: number }> {
      const page = Math.max(1, filters.page ?? 1);
      const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));
      const conditions = ["team_id = $1"];
      const params: unknown[] = [teamId];
      let i = 2;
      if (filters.search) {
        conditions.push(`(title ILIKE $${i} OR $${i} = ANY(tags))`);
        params.push(`%${filters.search}%`);
        i += 1;
      }
      if (filters.tag) {
        conditions.push(`$${i} = ANY(tags)`);
        params.push(filters.tag);
        i += 1;
      }
      if (filters.minScore !== undefined) {
        conditions.push(`score >= $${i}`);
        params.push(filters.minScore);
      }
      const where = conditions.join(" AND ");
      const [{ rows }, countRows] = await Promise.all([
        db.query<LibraryPromptRow>(
          `SELECT * FROM library_prompts WHERE ${where} ORDER BY usage_count DESC, created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
          params,
        ),
        db.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM library_prompts WHERE ${where}`,
          params,
        ),
      ]);
      return { prompts: rows, total: Number(countRows.rows[0]?.total ?? 0) };
    },

    async findById(id: string): Promise<LibraryPromptRow | undefined> {
      const { rows } = await db.query<LibraryPromptRow>(
        "SELECT * FROM library_prompts WHERE id = $1 LIMIT 1",
        [id],
      );
      return rows[0];
    },

    async incrementUsage(id: string): Promise<void> {
      await db.query("UPDATE library_prompts SET usage_count = usage_count + 1 WHERE id = $1", [
        id,
      ]);
    },

    async countByTeamAndHash(teamId: string, hash: string): Promise<number> {
      const { rows } = await db.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM library_prompts WHERE team_id = $1 AND prompt_hash = $2",
        [teamId, hash],
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type LibraryRepo = ReturnType<typeof createLibraryRepo>;
