import type { SqlDb } from "@revealyst/db";

/** Client-side cap on any single DB query (stale sockets hang without it). */
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

/** SqlDb with an explicit close, for per-request connection lifecycle. */
export interface RequestDb extends SqlDb {
  end(): Promise<void>;
}

/**
 * Create a postgres.js connection for ONE request. Cloudflare Workers
 * forbids sharing socket I/O across requests — a connection created in one
 * request handler cannot be written to from another ("Cannot perform I/O on
 * behalf of a different request"). Pooling across requests therefore caused
 * intermittent 500s and hangs on the live worker. Every request gets its own
 * connection (1-2s connect cost via Hyperdrive, acceptable for this API),
 * which `closeRequestDb()` tears down after the response.
 */
function createPostgresDb(connectionString: string): Promise<RequestDb> {
  return import("postgres").then(({ default: postgres }) => {
    // Hyperdrive terminates TLS at Cloudflare's edge; its connection string
    // is sslmode-tuned, so don't force ssl. Direct external Postgres
    // (DATABASE_URL fallback) requires TLS.
    const isHyperdrive = /\.hyperdrive\.local/i.test(connectionString);
    // postgres.js sends `parameters` in the startup packet at runtime, but
    // its types omit it — cast to add the connection GUCs.
    const sql = postgres(connectionString, {
      prepare: false,
      max: 1,
      idle_timeout: 0,
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
        const rows = await withTimeout(
          () => sql.unsafe<T[]>(text, params as never[]),
          QUERY_TIMEOUT_MS,
        );
        return { rows };
      },
      async end() {
        try {
          await sql.end({ timeout: 1 });
        } catch {
          // already closed
        }
      },
    };
  });
}

export interface DbBindings {
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
  _DB?: SqlDb;
}

// One connection per request, keyed on the per-request env object (Cloudflare
// creates a fresh env per request, so this is naturally request-scoped).
const perRequest = new WeakMap<object, Promise<RequestDb>>();

export function getDb(bindings: DbBindings): Promise<RequestDb> {
  if (bindings._DB) return Promise.resolve(bindings._DB as RequestDb);
  const connectionString = bindings.HYPERDRIVE?.connectionString ?? bindings.DATABASE_URL;
  let db = perRequest.get(bindings);
  if (!db) {
    db = createPostgresDb(connectionString);
    perRequest.set(bindings, db);
  }
  return db;
}

/** Close this request's connection (called by middleware after the response). */
export function closeRequestDb(bindings: DbBindings): Promise<void> {
  const db = perRequest.get(bindings);
  if (!db) return Promise.resolve();
  perRequest.delete(bindings);
  return db.then((d) => d.end()).catch(() => {});
}
