import { describe, expect, it, vi } from "vitest";
import { closeRequestDb, getDb } from "../src/db.js";

// createPostgresDb lazily imports "postgres"; stub it so no real socket opens.
vi.mock("postgres", () => ({
  default: vi.fn(() => ({
    unsafe: vi.fn(() => new Promise(() => {})), // queries hang by default
    end: vi.fn().mockResolvedValue(undefined),
  })),
}));

const { default: postgres } = await import("postgres");
const postgresMock = vi.mocked(postgres);

const hyperdriveConn = "postgres://pooler.hyperdrive.local:6543/revealyst";
const directConn = "postgres://user:pass@db.example.com:5432/revealyst";

describe("getDb per-request connection lifecycle", () => {
  it("reuses one connection within a request (same env object)", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    const env = { DATABASE_URL: directConn };
    const first = await getDb(env);
    const second = await getDb(env); // same request → same env object
    expect(second).toBe(first);
    expect(postgresMock.mock.calls.length - callsBefore).toBe(1);
  });

  it("creates a separate connection for a different request (fresh env object)", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    const a = await getDb({ DATABASE_URL: "postgres://a:5432/x" });
    const b = await getDb({ DATABASE_URL: "postgres://b:5432/x" });
    expect(a).not.toBe(b);
    expect(postgresMock.mock.calls.length - callsBefore).toBe(2);
  });

  it("prefers the Hyperdrive connection string", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    await getDb({ DATABASE_URL: directConn, HYPERDRIVE: { connectionString: hyperdriveConn } });
    expect(postgresMock.mock.calls.length - callsBefore).toBe(1);
    expect(postgresMock.mock.calls[callsBefore]?.[0]).toBe(hyperdriveConn);
  });

  it("falls back to DATABASE_URL when Hyperdrive is absent", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    await getDb({ DATABASE_URL: directConn });
    expect(postgresMock.mock.calls.length - callsBefore).toBe(1);
    expect(postgresMock.mock.calls[callsBefore]?.[0]).toBe(directConn);
  });

  it("configures timeouts and no cross-request pooling", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    await getDb({ DATABASE_URL: directConn });
    const options = postgresMock.mock.calls[callsBefore]?.[1] as Record<string, unknown>;
    expect(options.connect_timeout).toBe(10);
    expect(options.max).toBe(1);
    expect(options.prepare).toBe(false);
  });

  it("returns the test seam _DB without touching postgres", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    const fakeDb = { query: vi.fn() } as never;
    const db = await getDb({ DATABASE_URL: directConn, _DB: fakeDb });
    expect(db).toBe(fakeDb);
    expect(postgresMock.mock.calls.length).toBe(callsBefore);
    // closing a _DB request is a no-op
    await expect(
      closeRequestDb({ DATABASE_URL: directConn, _DB: fakeDb }),
    ).resolves.toBeUndefined();
  });

  it("times out a hung query and retries once on a fresh connection", async () => {
    vi.useFakeTimers();
    try {
      const callsBefore = postgresMock.mock.calls.length;
      const db = await getDb({ DATABASE_URL: "postgres://hang:5432/x" });

      const query = db.query("SELECT 1");
      const assertion = expect(query).rejects.toThrow(/timed out/);
      // attempt 1 times out at 15s, retries on a fresh connection, attempt 2
      // times out at 15s too (mock hangs forever)
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      // two pool instances were created (initial + retry)
      expect(postgresMock.mock.calls.length - callsBefore).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the request connection on closeRequestDb", async () => {
    const env = { DATABASE_URL: "postgres://close:5432/x" };
    await getDb(env); // create (and hold) the request connection
    const sql = postgresMock.mock.results.at(-1)?.value as { end: ReturnType<typeof vi.fn> };
    await closeRequestDb(env);
    expect(sql.end).toHaveBeenCalled();
    // a subsequent close is a no-op
    await expect(closeRequestDb(env)).resolves.toBeUndefined();
  });
});
