import type { SqlDb } from "@revealyst/db";

/**
 * postgres.js-backed SqlDb for the Worker runtime. Imported lazily (postgres
 * is heavy and only needed on DB routes); `prepare: false` keeps the socket
 * layer compatible with Cloudflare Workers (nodejs_compat).
 */
export async function createPostgresDb(connectionString: string): Promise<SqlDb> {
  const { default: postgres } = await import("postgres");
  // SSL required: RDS public endpoints enforce TLS (postgres.js default is
  // "require" for non-localhost, made explicit here).
  const sql = postgres(connectionString, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    ssl: "require",
  });
  return {
    async query<T extends object>(text: string, params: unknown[] = []) {
      const rows = await sql.unsafe<T[]>(text, params as never[]);
      return { rows };
    },
  };
}

const memo = new WeakMap<object, Promise<SqlDb>>();

/** One pooled connection per Worker instance (isolate), reused across requests. */
export function getDb(bindings: { DATABASE_URL: string; _DB?: SqlDb }): Promise<SqlDb> {
  if (bindings._DB) return Promise.resolve(bindings._DB);
  let cached = memo.get(bindings);
  if (!cached) {
    cached = createPostgresDb(bindings.DATABASE_URL).catch((error) => {
      memo.delete(bindings);
      throw error;
    });
    memo.set(bindings, cached);
  }
  return cached;
}
