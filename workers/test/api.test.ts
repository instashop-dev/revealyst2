import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPoolDb, runMigrations } from "@revealyst/db";
import { DataType, newDb } from "pg-mem";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "../src/env.js";
import app from "../src/index.js";
import { createRepos } from "../src/db/index.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const TEST_SECRET = "test-secret-0123456789abcdef0123456789abcdef";

let env: WorkerEnv;
let managerUserId: string;
let memberUserId: string;
let teamId: string;
let sessionToken: string;
let managerToken: string;
const openaiFetch = vi.fn();

async function makeEnv(): Promise<WorkerEnv> {
  const mem = newDb();
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  await runMigrations(pool, MIGRATIONS_DIR);
  const db = createPgPoolDb(pool);

  // Seed: manager + member + team
  const repos = createRepos(db);
  const manager = await repos.users.create("rohan@example.com");
  const member = await repos.users.create("jamie@example.com");
  managerUserId = manager.id;
  memberUserId = member.id;
  const team = await repos.teams.create("Acme Agency", managerUserId);
  teamId = team.id;
  await repos.teams.addMember(teamId, memberUserId, "member", "User_A");
  await repos.teams.addMember(teamId, managerUserId, "manager", "User_B");

  return {
    DATABASE_URL: "postgres://unused", // overridden by _DB
    JWT_SECRET: TEST_SECRET,
    OPENAI_API_KEY: "test-openai-key",
    APP_URL: "http://localhost:8788",
    VECTORIZE_NAMESPACE: "prompt-patterns",
    LIBRARY_ENC_KEY: TEST_SECRET,
    DEV_MODE: "true",
    RATE_LIMIT_DISABLED: "true",
    VECTORIZE: {
      query: async () => ({
        matches: [
          {
            id: "p_role_1",
            score: 0.92,
            metadata: {
              id: "p_role_1",
              category: "add_role",
              pattern_text: "Give the AI a defined expert role before the task.",
              preview: "Act as a senior marketing strategist. ",
              fixes_flags: ["missing_role"],
              priority: 1,
            },
          },
        ],
      }),
    } as unknown as WorkerEnv["VECTORIZE"],
    _DB: db,
  };
}

beforeAll(async () => {
  env = await makeEnv();
  // Stub OpenAI: embedding + chat completion endpoints
  openaiFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.01) }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/v1/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  suggestions: [
                    {
                      id: "add_role",
                      type: "add_role",
                      text: "Give the AI a defined expert role.",
                      preview: "Act as a senior marketing strategist. ",
                      action: "prepend",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unexpected url", { status: 500 });
  });
  vi.stubGlobal("fetch", openaiFetch);

  // Auth flow: magic → verify → session
  const magic = await app.request(
    "/api/auth/magic",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "jamie@example.com" }),
    },
    env,
  );
  expect(magic.status).toBe(200);
  const magicBody = (await magic.json()) as { dev_link?: string };
  const token = new URL(magicBody.dev_link as string).searchParams.get("token") as string;
  const verify = await app.request(
    "/api/auth/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    },
    env,
  );
  expect(verify.status).toBe(200);
  const session = (await verify.json()) as { token: string };
  sessionToken = session.token;

  // Manager session (rohan) for dashboard tests
  const managerMagic = await app.request(
    "/api/auth/magic",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "rohan@example.com" }),
    },
    env,
  );
  const managerTokenRaw = new URL(
    ((await managerMagic.json()) as { dev_link: string }).dev_link,
  ).searchParams.get("token") as string;
  const managerVerify = await app.request(
    "/api/auth/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: managerTokenRaw }),
    },
    env,
  );
  managerToken = ((await managerVerify.json()) as { token: string }).token;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const authed = (body?: unknown, token = sessionToken) => ({
  method: body === undefined ? "GET" : "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("health + openapi", () => {
  it("serves /api/health", async () => {
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: "ok" });
  });

  it("serves the OpenAPI document", async () => {
    const res = await app.request("/api/openapi.json", {}, env);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { info: { title: string }; paths: Record<string, unknown> };
    expect(doc.info.title).toBe("Revealyst API");
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/api/auth/magic",
        "/api/suggestion",
        "/api/event",
        "/api/library",
        "/api/team/dashboard",
      ]),
    );
  });
});

describe("auth", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await app.request("/api/auth/me", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns the current user with a valid session", async () => {
    const res = await app.request("/api/auth/me", authed(), env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { email: string }).toMatchObject({ email: "jamie@example.com" });
  });
});

describe("auth email delivery", () => {
  const prodEnv = (extra: Partial<WorkerEnv> = {}): WorkerEnv => ({
    ...env,
    DEV_MODE: "false",
    ...extra,
  });
  const magicRequest = (email: string, e: WorkerEnv = env) =>
    app.request(
      "/api/auth/magic",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      },
      e,
    );

  // Restore the OpenAI fetch stub — magic-link tests swap global fetch for SES.
  afterEach(() => {
    vi.stubGlobal("fetch", openaiFetch);
  });

  it("sends the link via SES in production and does not expose it", async () => {
    const sesFetch = vi.fn(
      async () => new Response(JSON.stringify({ MessageId: "m-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", sesFetch);
    const res = await app.request(
      "/api/auth/magic",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "emailuser@example.com" }),
      },
      prodEnv({
        SES_ACCESS_KEY_ID: "AKIDEXAMPLE",
        SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        SES_REGION: "us-east-1",
        SES_FROM_EMAIL: "Revealyst <noreply@e.revealyst.com>",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; dev_link?: string };
    expect(body.message).toBe("link sent");
    expect(body.dev_link).toBeUndefined();

    expect(sesFetch).toHaveBeenCalledTimes(1);
    const [url, init] = sesFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    const sent = JSON.parse(init.body as string) as {
      Destination: { ToAddresses: string[] };
      Content: { Simple: { Body: { Html: { Data: string } } } };
    };
    expect(sent.Destination.ToAddresses).toEqual(["emailuser@example.com"]);
    expect(sent.Content.Simple.Body.Html.Data).toContain("http://localhost:8788/auth/verify?token=");
  });

  it("returns 200 without leaking delivery state when SES is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unexpected", { status: 500 })),
    );
    const res = await magicRequest("noses@example.com", prodEnv());
    expect(res.status).toBe(200);
    // uniform body — no config-state or recency oracle
    expect((await res.json()) as { message: string }).toEqual({ message: "link sent" });
  });

  it("suppresses repeat sends to the same recipient (cooldown)", async () => {
    const sesFetch = vi.fn(
      async () => new Response(JSON.stringify({ MessageId: "m-2" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", sesFetch);
    const envWithSes = prodEnv({
      SES_ACCESS_KEY_ID: "AKIDEXAMPLE",
      SES_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    });
    const first = await magicRequest("cooldown@example.com", envWithSes);
    const second = await magicRequest("cooldown@example.com", envWithSes);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // only one SES send despite two requests
    expect(sesFetch).toHaveBeenCalledTimes(1);
  });
});

describe("token type separation (security: magic vs session)", () => {
  it("rejects a session token on the verify endpoint", async () => {
    const res = await app.request(
      "/api/auth/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: sessionToken }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a magic token as a Bearer session token", async () => {
    const magic = await app.request(
      "/api/auth/magic",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "magic-bearer@example.com" }),
      },
      env,
    );
    const magicToken = new URL(
      ((await magic.json()) as { dev_link: string }).dev_link,
    ).searchParams.get("token") as string;
    const res = await app.request("/api/auth/me", authed(undefined, magicToken), env);
    expect(res.status).toBe(401);
  });

  it("enforces single-use magic links: a second verify with the same token is rejected", async () => {
    const magic = await app.request(
      "/api/auth/magic",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "single-use@example.com" }),
      },
      env,
    );
    const magicToken = new URL(
      ((await magic.json()) as { dev_link: string }).dev_link,
    ).searchParams.get("token") as string;
    const verify = (t: string) =>
      app.request(
        "/api/auth/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: t }),
        },
        env,
      );
    const first = await verify(magicToken);
    expect(first.status).toBe(200);
    const second = await verify(magicToken); // replay of the consumed link
    expect(second.status).toBe(401);
  });
});

describe("suggestion", () => {
  it("returns suggestions via vectorize+llm (stubbed)", async () => {
    const res = await app.request(
      "/api/suggestion",
      authed({ flags: ["missing_role"], prompt_hash: "abc12345" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      suggestions: Array<{ id: string; preview: string }>;
    };
    expect(body.source).toBe("vectorize+llm");
    expect(body.suggestions[0]?.id).toBe("add_role");
    expect(body.suggestions[0]?.preview).toContain("Act as");
  });

  it("infers deficiencies from a score breakdown when flags are absent", async () => {
    const res = await app.request(
      "/api/suggestion",
      authed({
        score_breakdown: {
          specificity: 40,
          context: 80,
          role_clarity: 90,
          output_format: 90,
          examples_included: 90,
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    // inference produced low_specificity; stub returns the canned suggestion anyway
    expect((await res.json()) as { suggestions: unknown[] }).toHaveProperty("suggestions");
  });

  it("falls back to static suggestions when upstream fails", async () => {
    // embedding is retried once — reject both attempts so the whole path fails
    openaiFetch.mockRejectedValueOnce(new Error("network down"));
    openaiFetch.mockRejectedValueOnce(new Error("network down"));
    const res = await app.request("/api/suggestion", authed({ flags: ["missing_role"] }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; suggestions: Array<{ preview: string }> };
    expect(body.source).toBe("static");
    expect(body.suggestions.length).toBeGreaterThan(0);
  });
});

describe("events + dashboard", () => {
  it("logs an anonymised event and reflects it in the manager dashboard", async () => {
    const eventRes = await app.request(
      "/api/event",
      authed({
        prompt_hash: "sha256-event-1",
        score: 45,
        flags: ["missing_role", "missing_output_format"],
        breakdown: {
          specificity: 40,
          context: 50,
          role_clarity: 30,
          output_format: 50,
          examples_included: 10,
        },
        llm_platform: "chat.openai.com",
        team_id: teamId,
        user_anon_id: "anon-jamie",
      }),
      env,
    );
    expect(eventRes.status).toBe(200);

    const dashRes = await app.request(
      `/api/team/dashboard?team_id=${teamId}&period=7d`,
      authed(undefined, managerToken),
      env,
    );
    expect(dashRes.status).toBe(200);
    const dash = (await dashRes.json()) as {
      avg_score: number | null;
      common_weaknesses: Array<{ flag: string }>;
      trends_by_user: Array<{ user: string }>;
    };
    expect(dash.avg_score).toBe(45);
    expect(dash.common_weaknesses.map((w) => w.flag).sort()).toEqual([
      "missing_output_format",
      "missing_role",
    ]);
    expect(dash.trends_by_user[0]?.user).toMatch(/^User /);
  });

  it("blocks non-managers from the dashboard", async () => {
    // member session (jamie) — not a manager
    const res = await app.request(
      `/api/team/dashboard?team_id=${teamId}`,
      authed(undefined, sessionToken),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("library", () => {
  let savedId: string;

  it("saves, dedupes, lists and decrypts a prompt", async () => {
    const saveRes = await app.request(
      "/api/library",
      authed({
        team_id: teamId,
        prompt_text: "Write a cold email for our CRM tool.",
        title: "Cold email opener",
        tags: ["email", "sales"],
        score: 88,
      }),
      env,
    );
    expect(saveRes.status).toBe(201);
    const saved = (await saveRes.json()) as { id: string; title: string; score: number };
    savedId = saved.id;
    expect(saved.title).toBe("Cold email opener");
    expect(saved.score).toBe(88);

    // duplicate → 409
    const dupRes = await app.request(
      "/api/library",
      authed({
        team_id: teamId,
        prompt_text: "Write a cold email for our CRM tool.",
      }),
      env,
    );
    expect(dupRes.status).toBe(409);

    // list metadata (no plaintext)
    const listRes = await app.request(`/api/library?team_id=${teamId}&tag=sales`, authed(), env);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      prompts: Array<{ id: string; title: string }>;
      total: number;
    };
    expect(list.total).toBe(1);
    expect(list.prompts[0]?.id).toBe(savedId);

    // fetch decrypted body
    const getRes = await app.request(`/api/library/${savedId}`, authed(), env);
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { prompt_text: string }).prompt_text).toBe(
      "Write a cold email for our CRM tool.",
    );
  });

  it("rejects saving to a team the user does not belong to", async () => {
    // create a user outside the team
    const magic = await app.request(
      "/api/auth/magic",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "outsider@example.com" }),
      },
      env,
    );
    const token = new URL(((await magic.json()) as { dev_link: string }).dev_link).searchParams.get(
      "token",
    ) as string;
    const verify = await app.request(
      "/api/auth/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
      env,
    );
    const outsiderToken = ((await verify.json()) as { token: string }).token;

    const res = await app.request(
      "/api/library",
      authed({ team_id: teamId, prompt_text: "nope" }, outsiderToken),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("feedback", () => {
  it("records accepted/rejected suggestions", async () => {
    const res = await app.request(
      "/api/feedback",
      authed({ suggestion_id: "add_role", was_accepted: true }),
      env,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { success: boolean }).toEqual({ success: true });
  });
});

describe("rate limiting", () => {
  it("returns 429 past the limit", async () => {
    const limitedEnv: WorkerEnv = { ...env, RATE_LIMIT_DISABLED: "false" };
    // suggestion limiter: 30/min — exceed it
    let lastStatus = 0;
    for (let i = 0; i < 35; i++) {
      const res = await app.request(
        "/api/suggestion",
        authed({ flags: ["missing_role"] }),
        limitedEnv,
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
