import type { Pool } from "pg";

/**
 * Thin, driver-agnostic SQL surface used by the repositories. The Worker
 * speaks postgres.js (via its Cloudflare-compatible wrapper) and tests speak
 * pg-mem/pg — the repository code never depends on either driver directly.
 */
export interface QueryResult<T extends object> {
  rows: T[];
}

export interface SqlDb {
  query<T extends object>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** Wrap a node-postgres Pool (used for tests via pg-mem's pg adapter). */
export function createPgPoolDb(pool: Pool): SqlDb {
  return {
    async query<T extends object>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await pool.query(text, params as never[]);
      return { rows: result.rows as T[] };
    },
  };
}
