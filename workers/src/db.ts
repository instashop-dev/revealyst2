import type { SqlDb } from "@revealyst/db";

/** Client-side cap on any single DB query (Hyperdrive half-open sockets hang without it). */
export const QUERY_TIMEOUT_MS = 10_000;

class QueryTimeoutError extends Error {
  readonly timedOut = true;
  constructor(ms: number) {
    super(`db query timed out after ${ms}ms`);
  }
}

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new QueryTimeoutError(ms)), ms);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * postgres.js-backed SqlDb for the Worker runtime. Imported lazily (postgres
 * is heavy and only needed on DB routes); `prepare: false` keeps the socket
 * layer compatible with Cloudflare Workers (nodejs_compat).
 *
 * Every query is race-guarded by QUERY_TIMEOUT_MS. Cloudflare freezes idle
 * isolates with the pool sockets still open; Hyperdrive (or the origin) may
 * close those connections meanwhile, leaving *half-open* sockets that never
 * error — without this guard, a query on such a socket hangs forever and
 * exhausts the pool's `max` slots (observed live: requests hanging 5+ min,
 * then failing with no logs). On timeout the pool is torn down so the next
 * getDb() creates fresh connections.
 */
export async function createPostgresDb(connectionString: string, poolKey: string): Promise<SqlDb> {
  const { default: postgres } = await import("postgres");
  // Hyperdrive terminates TLS at Cloudflare's edge and its connection string
  // is already sslmode-tuned, so don't force ssl for it. Direct external
  // Postgres (DATABASE_URL fallback) requires TLS.
  const isHyperdrive = /\.hyperdrive\.local/i.test(connectionString);
  // postgres.js sends `parameters` in the startup packet at runtime, but its
  // types omit it — cast to add the connection GUCs. They are honored on the
  // direct-DATABASE_URL path; Hyperdrive may not forward them, which is why
  // the client-side timeout above is the primary guard.
  const sql = postgres(connectionString, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    max_lifetime: 60,
    connect_timeout: 10,
    parameters: {
      statement_timeout: "10000",
      lock_timeout: "8000",
      idle_in_transaction_session_timeout: "10000",
      application_name: "revealyst-workers",
    },
    ...(isHyperdrive ? {} : { ssl: "require" as const }),
  } as Parameters<typeof postgres>[1] & { parameters: Record<string, string> });
  return {
    async query<T extends object>(text: string, params: unknown[] = []) {
      try {
        const rows = await withTimeout(
          () => sql.unsafe<T[]>(text, params as never[]),
          QUERY_TIMEOUT_MS,
        );
        return { rows };
      } catch (error) {
        if (error instanceof QueryTimeoutError) {
          // Drop the dead pool so the next request starts fresh.
          try {
            await sql.end({ timeout: 1 });
          } catch {
            // already closed
          }
          globalPool.delete(poolKey);
        }
        throw error;
      }
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
    cached = createPostgresDb(connectionString, connectionString).catch((error) => {
      globalPool.delete(connectionString);
      throw error;
    });
    globalPool.set(connectionString, cached);
  }
  return cached;
}
