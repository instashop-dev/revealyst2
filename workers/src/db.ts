import type { SqlDb } from "@revealyst/db";

/**
 * postgres.js-backed SqlDb for the Worker runtime. Imported lazily (postgres
 * is heavy and only needed on DB routes); `prepare: false` keeps the socket
 * layer compatible with Cloudflare Workers (nodejs_compat).
 */
export async function createPostgresDb(connectionString: string): Promise<SqlDb> {
  const { default: postgres } = await import("postgres");
  // Hyperdrive terminates TLS at Cloudflare's edge and its connection string
  // is already sslmode-tuned, so don't force ssl for it. Direct external
  // Postgres (DATABASE_URL fallback) requires TLS.
  const isHyperdrive = /\.hyperdrive\.local/i.test(connectionString);
  const sql = postgres(connectionString, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    ...(isHyperdrive ? {} : { ssl: "require" as const }),
  });
  return {
    async query<T extends object>(text: string, params: unknown[] = []) {
      const rows = await sql.unsafe<T[]>(text, params as never[]);
      return { rows };
    },
  };
}

const memo = new WeakMap<object, Promise<SqlDb>>();

/**
 * One pooled connection per Worker instance (isolate), reused across requests.
 * Prefers the Hyperdrive proxy (Cloudflare-internal, reliable) and falls back
 * to the direct DATABASE_URL (e.g. local dev / tests).
 */
export function getDb(bindings: {
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
  _DB?: SqlDb;
}): Promise<SqlDb> {
  if (bindings._DB) return Promise.resolve(bindings._DB);
  const connectionString = bindings.HYPERDRIVE?.connectionString ?? bindings.DATABASE_URL;
  let cached = memo.get(bindings);
  if (!cached) {
    cached = createPostgresDb(connectionString).catch((error) => {
      memo.delete(bindings);
      throw error;
    });
    memo.set(bindings, cached);
  }
  return cached;
}
