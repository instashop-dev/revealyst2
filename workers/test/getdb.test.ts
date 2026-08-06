import { describe, expect, it, vi } from "vitest";
import { getDb } from "../src/db.js";

// createPostgresDb lazily imports "postgres"; stub it so no real socket opens.
vi.mock("postgres", () => ({
  default: vi.fn(() => ({ unsafe: vi.fn() })),
}));

const { default: postgres } = await import("postgres");
const postgresMock = vi.mocked(postgres);

describe("getDb pool lifecycle", () => {
  it("creates exactly one pool per connection string across many env objects", async () => {
    const conn = "postgres://one:5432/x";
    const callsBefore = postgresMock.mock.calls.length;
    const first = await getDb({ DATABASE_URL: conn });
    const second = await getDb({ DATABASE_URL: conn }); // fresh env object, like Workers does
    const third = await getDb({ DATABASE_URL: conn });
    expect(second).toBe(first);
    expect(third).toBe(first);
    // one pool creation for this connection string
    expect(postgresMock.mock.calls.length - callsBefore).toBe(1);
  });

  it("prefers the Hyperdrive connection string", async () => {
    const hd = "postgres://hyperdrive.local:6543/db";
    const callsBefore = postgresMock.mock.calls.length;
    await getDb({
      DATABASE_URL: "postgres://fallback:5432/x",
      HYPERDRIVE: { connectionString: hd },
    });
    expect(postgresMock.mock.calls.length - callsBefore).toBe(1);
    expect(postgresMock.mock.calls[callsBefore]?.[0]).toBe(hd);
  });

  it("falls back to DATABASE_URL when Hyperdrive is absent", async () => {
    const conn = "postgres://three:5432/x";
    const callsBefore = postgresMock.mock.calls.length;
    await getDb({ DATABASE_URL: conn });
    expect(postgresMock.mock.calls.length - callsBefore).toBe(1);
    expect(postgresMock.mock.calls[callsBefore]?.[0]).toBe(conn);
  });

  it("creates a separate pool for a different connection string", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    const a = await getDb({ DATABASE_URL: "postgres://a:5432/x" });
    const b = await getDb({ DATABASE_URL: "postgres://b:5432/x" });
    expect(a).not.toBe(b);
    expect(postgresMock.mock.calls.length - callsBefore).toBe(2);
  });

  it("returns the test seam _DB without touching postgres", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    const fakeDb = { query: vi.fn() } as never;
    const db = await getDb({ DATABASE_URL: "postgres://seam:5432/x", _DB: fakeDb });
    expect(db).toBe(fakeDb);
    expect(postgresMock.mock.calls.length).toBe(callsBefore);
  });

  it("configures self-healing timeouts so hung queries cannot hold locks forever", async () => {
    const callsBefore = postgresMock.mock.calls.length;
    await getDb({ DATABASE_URL: "postgres://timeouts:5432/x" });
    const options = postgresMock.mock.calls[callsBefore]?.[1] as Record<string, unknown> & {
      parameters?: Record<string, string>;
    };
    expect(options.connect_timeout).toBe(10);
    expect(options.parameters).toMatchObject({
      statement_timeout: "10000",
      lock_timeout: "8000",
      idle_in_transaction_session_timeout: "10000",
    });
  });
});
