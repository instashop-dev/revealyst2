import { describe, expect, it, vi } from "vitest";
import { closeRequestDb, getDb } from "../src/db.js";

// createPostgresDb lazily imports "postgres"; stub it so no real socket opens.
vi.mock("postgres", () => ({
  default: vi.fn(() => ({ unsafe: vi.fn(), end: vi.fn().mockResolvedValue(undefined) })),
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

  it("configures self-healing timeouts", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    await getDb({ DATABASE_URL: directConn });
    const options = postgresMock.mock.calls[callsBefore]?.[1] as Record<string, unknown> & {
      parameters?: Record<string, string>;
    };
    expect(options.connect_timeout).toBe(10);
    expect(options.max).toBe(1);
    expect(options.parameters).toMatchObject({
      statement_timeout: "10000",
      lock_timeout: "8000",
      idle_in_transaction_session_timeout: "10000",
    });
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

  it("times out a hung query", async () => {
    vi.useFakeTimers();
    try {
      const db = await getDb({ DATABASE_URL: "postgres://hang:5432/x" });
      const sql = postgresMock.mock.results.at(-1)?.value as {
        unsafe: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      sql.unsafe.mockImplementation(() => new Promise(() => {})); // never resolves

      const query = db.query("SELECT 1");
      const assertion = expect(query).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
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
