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

const globalPool = new Map<string, Promise<SqlDb>>();

/**
 * One pooled connection per connection string per isolate, reused across
 * requests. Prefers the Hyperdrive proxy (Cloudflare-internal, reliable) and
 * falls back to the direct DATABASE_URL (e.g. local dev / tests).
 *
 * Cache is module-global keyed by connection string — NOT keyed on the
 * bindings object, because Cloudflare creates a fresh env object per request;
 * a WeakMap keyed on env would spawn a new pool (and up to `max` sockets)
 * per request and exhaust the upstream connection limit.
 */
export function getDb(bindings: {
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
  _DB?: SqlDb;
}): Promise<SqlDb> {
  if (bindings._DB) return Promise.resolve(bindings._DB);
  const connectionString = bindings.HYPERDRIVE?.connectionString ?? bindings.DATABASE_URL;
  let cached = globalPool.get(connectionString);
  if (!cached) {
    cached = createPostgresDb(connectionString).catch((error) => {
      globalPool.delete(connectionString);
      throw error;
    });
    globalPool.set(connectionString, cached);
  }
  return cached;
}
