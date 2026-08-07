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
  sort?: "most_used" | "highest_score" | "newest";
}

export type LibrarySort = NonNullable<LibraryFilters["sort"]>;

const ORDER_BY: Record<LibrarySort, string> = {
  most_used: "usage_count DESC, created_at DESC",
  highest_score: "score DESC NULLS LAST, usage_count DESC",
  newest: "created_at DESC",
};

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
      const orderBy = ORDER_BY[filters.sort ?? "most_used"];
      const [{ rows }, countRows] = await Promise.all([
        db.query<LibraryPromptRow>(
          `SELECT * FROM library_prompts WHERE ${where} ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
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
      await db.query(
        "UPDATE library_prompts SET usage_count = usage_count + 1, last_used_at = now() WHERE id = $1",
        [id],
      );
    },

    /**
     * Create a new version of a prompt (spec §5.6: each edit preserves the
     * original by linking parent_id and bumping version). The prompt body is
     * re-encrypted with the current key.
     */
    async createVersion(
      parent: LibraryPromptRow,
      body: {
        encryptedPrompt: string;
        promptHash: string;
        title: string | null;
        tags: string[];
        score: number;
        createdBy: string;
      },
    ): Promise<LibraryPromptRow> {
      const { rows } = await db.query<LibraryPromptRow>(
        `INSERT INTO library_prompts (team_id, title, prompt_text_encrypted, prompt_hash, tags, created_by, score, version, parent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          parent.team_id,
          body.title,
          body.encryptedPrompt,
          body.promptHash,
          body.tags,
          body.createdBy,
          body.score,
          parent.version + 1,
          parent.id,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("library version insert returned no row");
      return row;
    },

    /** Update card metadata (title/tags for members; notes/standard for managers). */
    async updateMeta(
      id: string,
      patch: {
        title?: string | null;
        tags?: string[];
        notes?: string | null;
        isStandard?: boolean;
      },
    ): Promise<LibraryPromptRow | undefined> {
      const { rows } = await db.query<LibraryPromptRow>(
        `UPDATE library_prompts SET
           title = COALESCE($2, title),
           tags = COALESCE($3, tags),
           notes = COALESCE($4, notes),
           is_standard = COALESCE($5, is_standard)
         WHERE id = $1 RETURNING *`,
        [
          id,
          patch.title === undefined ? null : patch.title,
          patch.tags === undefined ? null : patch.tags,
          patch.notes === undefined ? null : patch.notes,
          patch.isStandard === undefined ? null : patch.isStandard,
        ],
      );
      return rows[0];
    },

    /** All versions of a prompt, oldest first (walking the version chain). */
    async listVersions(id: string): Promise<LibraryPromptRow[]> {
      // Walk up to the oldest ancestor, then follow child links down.
      let root = await this.findById(id);
      const seen = new Set<string>();
      while (root?.parent_id && !seen.has(root.parent_id)) {
        seen.add(root.id);
        root = await this.findById(root.parent_id);
      }
      const versions: LibraryPromptRow[] = [];
      let cursor = root;
      const seenDown = new Set<string>();
      while (cursor && !seenDown.has(cursor.id)) {
        seenDown.add(cursor.id);
        versions.push(cursor);
        const { rows } = await db.query<LibraryPromptRow>(
          "SELECT * FROM library_prompts WHERE parent_id = $1 ORDER BY version LIMIT 1",
          [cursor.id],
        );
        cursor = rows[0];
      }
      return versions;
    },

    /** Team's top-scored prompts with bodies — copyable for the dashboard (spec §5.5). */
    async topForTeam(teamId: string, limit = 5): Promise<LibraryPromptRow[]> {
      const { rows } = await db.query<LibraryPromptRow>(
        "SELECT * FROM library_prompts WHERE team_id = $1 ORDER BY score DESC NULLS LAST, usage_count DESC, created_at DESC LIMIT $2",
        [teamId, limit],
      );
      return rows;
    },

    /** Prompts the user shared to the team library (achievement, spec §5.4). */
    async countSharedBy(userId: string): Promise<number> {
      const { rows } = await db.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM library_prompts WHERE created_by = $1",
        [userId],
      );
      return Number(rows[0]?.n ?? 0);
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
