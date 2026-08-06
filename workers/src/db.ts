import type { SqlDb } from "@revealyst/db";

/**
 * Client-side cap on a single DB query. Generous on purpose: Supabase
 * free-tier databases pause after inactivity and take 10-30s to wake, and
 * Hyperdrive sockets can go stale �� a single retry (below) covers transient
 * slowness without failing the request.
 */
export const QUERY_TIMEOUT_MS = 15_000;

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
  query<T extends object>(
    text: string,
    params?: unknown[],
    opts?: { protocol?: "simple" | "extended" },
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

/**
 * Create a postgres.js connection for ONE request. Cloudflare Workers
 * forbids sharing socket I/O across requests �� a connection created in one
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
    const makeSql = () =>
      postgres(connectionString, {
        prepare: false,
        // fetch_types: false skips the pg_type catalog query postgres.js runs
        // on every connect; built-in type parsers cover everything we use.
        fetch_types: false,
        max: 1,
        // Reuse the connection WITHIN the request (multiple queries per
        // route); the per-request lifecycle (closeRequestDb after the
        // response) guarantees no socket is shared across requests.
        idle_timeout: 60,
        connect_timeout: 10,
        ...(isHyperdrive ? {} : { ssl: "require" as const }),
      } as Parameters<typeof postgres>[1] & { parameters: Record<string, string> });

    let sql = makeSql();

    async function run<T extends object>(
      text: string,
      params: unknown[],
      simple: boolean,
      attempt: number,
    ): Promise<{ rows: T[] }> {
      const t0 = Date.now();
      try {
        const rows = await withTimeout(
          () =>
            sql.unsafe<T[]>(
              text,
              params as never[],
              {
                simple,
              } as Parameters<typeof sql.unsafe>[2] & { simple: boolean },
            ),
          QUERY_TIMEOUT_MS,
        );
        const ms = Date.now() - t0;
        if (ms > 2_000) {
          // slow-query visibility for ops (PII-safe: SQL text, not values)
          console.log(`[db] slow query ${ms}ms: ${text.slice(0, 80)}`);
        }
        return { rows };
      } catch (error) {
        const ms = Date.now() - t0;
        // timed-out queries never resolve; log the SQL (text only, never
        // parameter values) so ops can see exactly which query stalled
        console.error(
          `[db] query ${error instanceof QueryTimeoutError ? "TIMED OUT" : "FAILED"} after ${ms}ms (attempt ${attempt}): ${text.slice(0, 120)}`,
        );
        // recycle the suspect connection
        try {
          await sql.end({ timeout: 1 });
        } catch {
          // already closed
        }
        if (!(error instanceof QueryTimeoutError) || attempt >= 2) throw error;
        // retry once on a fresh connection (covers DB wake-up / stale socket)
        sql = makeSql();
        return run(text, params, simple, attempt + 1);
      }
    }

    return {
      async query<T extends object>(
        text: string,
        params: unknown[] = [],
        opts: { protocol?: "simple" | "extended" } = {},
      ) {
        // Default: simple protocol for param-less queries, extended otherwise
        // (postgres.js's default). NOTE: simple mode does NOT inline $N
        // params (they are dropped) �� only use it without params.
        const simple =
          opts.protocol === "simple" || (opts.protocol === undefined && params.length === 0);
        return run<T>(text, params, simple, 1);
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
