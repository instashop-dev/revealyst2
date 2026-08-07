#!/usr/bin/env node
/**
 * Revealyst full-stack journey e2e — exercises EVERY layer exactly like a
 * user would, against a LOCAL `wrangler dev` worker wired to the REAL
 * infrastructure (AWS RDS, Cloudflare Vectorize, OpenAI):
 *
 *   auth (magic → verify → session) → personal dashboard data (events →
 *   history → stats) → feedback → suggestion engine → team lifecycle
 *   (create → invite → auto-join → members → opt-in governance →
 *   dashboard) → shared library (save → dedupe → list → get → versioning →
 *   manager governance) → cleanup of test rows.
 *
 * Why this exists: the unit suites run against pg-mem (in-memory) and miss
 * driver/Postgres integration bugs (e.g. array params), and the live smoke
 * cannot complete an authenticated journey (no inbox). DEV_MODE=true on the
 * local worker returns magic links directly in the API response, so the full
 * auth round trip is testable without email.
 *
 * Usage:
 *   node e2e/journey.mjs [apiBase]
 *
 * Env:
 *   E2E_JOURNEY_API  default http://127.0.0.1:8788 (local wrangler dev)
 *   DATABASE_URL     required — cleans up test rows created by this run
 *
 * Exit code 0 = full journey passes; 1 = anything failed (test rows are
 * cleaned up even on failure).
 */

import pg from "pg";

const API = process.env.E2E_JOURNEY_API ?? "http://127.0.0.1:8788";
const DATABASE_URL = process.env.DATABASE_URL;

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const MANAGER_EMAIL = `e2e.journey.${RUN_ID}.manager@example.com`;
const MEMBER_EMAIL = `e2e.journey.${RUN_ID}.member@example.com`;
const PROMPT_TEXT = "Summarize the quarterly sales numbers into a slide deck outline";
const PROMPT_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEX64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let failures = 0;
let steps = 0;

function step(name) {
  steps += 1;
  console.log(`\n${steps}. ${name}`);
}
function pass(detail = "") {
  console.log(`   ✓ ${detail || "ok"}`);
}
function fail(name, detail) {
  failures += 1;
  console.error(`   ✗ ${name} — ${detail}`);
}

const TIMEOUT_MS = 45_000;

async function req(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body
  }
  return { status: res.status, json };
}

function expect(label, cond, detail) {
  if (cond) pass(detail);
  else fail(label, detail ?? "condition failed");
}

// ---------------------------------------------------------------------------
// 0. Health — verifies the local worker is up and the RDS path works
// ---------------------------------------------------------------------------
step("0. Health (worker up, RDS round-trip)");
{
  const h = await req("/api/health");
  expect("health", h.status === 200 && h.json?.status === "ok", `GET /api/health → ${h.status}`);
  const d = await req("/api/health?db=1");
  expect(
    "db health",
    d.status === 200 && d.json?.db === "ok",
    `GET /api/health?db=1 → ${d.status} db=${d.json?.db}`,
  );
}

// ---------------------------------------------------------------------------
// 1. Auth — manager signs in via magic link (spec §5.8)
// ---------------------------------------------------------------------------
step("1. Auth: magic link → verify → session");
const manager = { email: MANAGER_EMAIL };
let managerToken;
let memberToken;
let managerUserId;
let teamId;
let promptId;
{
  const m = await req("/api/auth/magic", { method: "POST", body: manager });
  expect("magic request", m.status === 200, `POST /api/auth/magic → ${m.status}`);
  expect("dev_link present", typeof m.json?.dev_link === "string", "dev_link returned (DEV_MODE)");
  const tokenParam = m.json?.dev_link?.split("token=")[1];
  expect("token extracted", Boolean(tokenParam), "magic token parsed from dev_link");

  const v = await req("/api/auth/verify", { method: "POST", body: { token: tokenParam } });
  expect(
    "verify",
    v.status === 200 && typeof v.json?.token === "string" && v.json?.user?.email === MANAGER_EMAIL,
    `POST /api/auth/verify → ${v.status} (session minted for ${v.json?.user?.email})`,
  );
  managerToken = v.json?.token;
  managerUserId = v.json?.user?.id;

  // Replay the same magic link → must be rejected (single-use, security)
  const v2 = await req("/api/auth/verify", { method: "POST", body: { token: tokenParam } });
  expect("single-use", v2.status === 401, `replayed link → ${v2.status} (expected 401)`);

  const me = await req("/api/auth/me", { token: managerToken });
  expect(
    "me",
    me.status === 200 && me.json?.id === managerUserId,
    `GET /api/auth/me → ${me.status} (${me.json?.email})`,
  );
}

// ---------------------------------------------------------------------------
// 2. Personal dashboard data (spec §5.4) + anonymous events (spec §5.7)
// ---------------------------------------------------------------------------
step("2. Events, history, stats, feedback");
{
  // Anonymous event (no session) — privacy-first default, must succeed.
  const anon = await req("/api/event", {
    method: "POST",
    body: { prompt_hash: PROMPT_HASH, score: 55, flags: ["vague_context"] },
  });
  expect(
    "anonymous event",
    anon.status === 200 && anon.json?.success === true,
    `anon event → ${anon.status}`,
  );

  // Authenticated events (own dashboard data).
  const evt = await req("/api/event", {
    method: "POST",
    token: managerToken,
    body: {
      prompt_hash: HEX64,
      score: 72,
      flags: ["missing_output_format"],
      breakdown: {
        specificity: 80,
        context: 55,
        role_clarity: 90,
        output_format: 40,
        examples_included: 10,
      },
      llm_platform: "chatgpt",
      rating: 1,
    },
  });
  expect(
    "auth event",
    evt.status === 200 && evt.json?.success === true,
    `auth event → ${evt.status}`,
  );

  const history = await req("/api/history?platform=chatgpt", { token: managerToken });
  expect(
    "history",
    history.status === 200 &&
      Array.isArray(history.json?.events) &&
      history.json.events.length >= 1 &&
      history.json.events[0]?.rating === 1,
    `GET /api/history → ${history.status} (${history.json?.events?.length ?? 0} events, rating=${history.json?.events?.[0]?.rating})`,
  );

  const stats = await req("/api/stats", { token: managerToken });
  expect(
    "stats",
    stats.status === 200 && stats.json?.prompts_count >= 1,
    `GET /api/stats → ${stats.status} (prompts=${stats.json?.prompts_count})`,
  );

  const fb = await req("/api/feedback", {
    method: "POST",
    token: managerToken,
    body: { suggestion_id: "add_output_format", was_accepted: true },
  });
  expect(
    "feedback",
    fb.status === 200 && fb.json?.success === true,
    `POST /api/feedback → ${fb.status}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Suggestion engine (spec §5.3) — real Vectorize + OpenAI, or static fallback
// ---------------------------------------------------------------------------
step("3. Suggestion engine");
{
  const s = await req("/api/suggestion", {
    method: "POST",
    body: { flags: ["missing_output_format", "vague_context"] },
  });
  const shape =
    s.status === 200 &&
    Array.isArray(s.json?.suggestions) &&
    s.json.suggestions.length >= 1 &&
    ["vectorize+llm", "static"].includes(s.json?.source) &&
    s.json.suggestions.every(
      (x) =>
        typeof x.id === "string" &&
        typeof x.preview === "string" &&
        ["prepend", "append", "insert"].includes(x.action),
    );
  expect(
    "suggestion",
    shape,
    `POST /api/suggestion → ${s.status} (${s.json?.suggestions?.length ?? 0} suggestions, source=${s.json?.source})`,
  );
}

// ---------------------------------------------------------------------------
// 4. Team lifecycle (spec §5.5 + §5.8)
// ---------------------------------------------------------------------------
step("4. Team: create → invite → auto-join → members → governance → dashboard");
{
  const t = await req("/api/team", {
    method: "POST",
    token: managerToken,
    body: { name: "Journey Team" },
  });
  expect(
    "create team",
    t.status === 201 && t.json?.id && t.json?.role === "manager",
    `POST /api/team → ${t.status} (${t.json?.id})`,
  );
  teamId = t.json?.id;

  const list = await req("/api/teams", { token: managerToken });
  expect(
    "list teams",
    list.status === 200 && list.json?.teams?.some((x) => x.id === teamId),
    `GET /api/teams → ${list.status} (${list.json?.teams?.length ?? 0} teams)`,
  );

  // Invite a member (manager only). The dev_link carries the team claim.
  const inv = await req("/api/team/invite", {
    method: "POST",
    token: managerToken,
    body: { team_id: teamId, email: MEMBER_EMAIL },
  });
  expect(
    "invite",
    inv.status === 200 && typeof inv.json?.dev_link === "string",
    `POST /api/team/invite → ${inv.status} (dev_link)`,
  );
  const invToken = inv.json?.dev_link?.split("token=")[1];

  // Member signs in via the invite link → auto-joins the team.
  const mv = await req("/api/auth/verify", { method: "POST", body: { token: invToken } });
  expect("member verify", mv.status === 200, `member verify → ${mv.status}`);
  memberToken = mv.json?.token;

  const members = await req(`/api/team/members?team_id=${teamId}`, { token: managerToken });
  expect(
    "members",
    members.status === 200 && members.json?.members?.length === 2,
    `GET /api/team/members → ${members.status} (${members.json?.members?.length ?? 0} members)`,
  );

  // Anonymisation governance (spec §5.5): the manager MAY toggle the setting,
  // but identifiable data must not be shown until every member opts in.
  const forced = await req("/api/team/settings", {
    method: "PATCH",
    token: managerToken,
    body: { team_id: teamId, anonymize_identities: false },
  });
  expect(
    "settings toggle allowed",
    forced.status === 200,
    `PATCH settings (no consent yet) → ${forced.status}`,
  );
  const before = await req(`/api/team/members?team_id=${teamId}`, { token: managerToken });
  expect(
    "hard enforce",
    before.status === 200 && before.json?.identifiable_enabled === false,
    `identifiable_enabled=${before.json?.identifiable_enabled} before consent (must be false)`,
  );

  const optMgr = await req("/api/team/opt-in", {
    method: "POST",
    token: managerToken,
    body: { team_id: teamId, enabled: true },
  });
  const optMem = await req("/api/team/opt-in", {
    method: "POST",
    token: memberToken,
    body: { team_id: teamId, enabled: true },
  });
  expect(
    "opt-ins",
    optMgr.status === 200 && optMem.status === 200,
    `opt-in manager=${optMgr.status} member=${optMem.status}`,
  );

  const settings = await req("/api/team/settings", {
    method: "PATCH",
    token: managerToken,
    body: { team_id: teamId, anonymize_identities: false },
  });
  expect(
    "identifiable on",
    settings.status === 200 && settings.json?.anonymize_identities === false,
    `PATCH /api/team/settings → ${settings.status}`,
  );

  const members2 = await req(`/api/team/members?team_id=${teamId}`, { token: managerToken });
  expect(
    "identifiable members",
    members2.status === 200 && members2.json?.identifiable_enabled === true,
    `members identifiable_enabled=${members2.json?.identifiable_enabled}`,
  );

  // Team-attributed event so the dashboard has real aggregates (spec §5.5).
  const teamEvt = await req("/api/event", {
    method: "POST",
    token: managerToken,
    body: {
      team_id: teamId,
      prompt_hash: HEX64,
      score: 78,
      flags: ["missing_examples"],
      llm_platform: "claude",
    },
  });
  expect(
    "team event",
    teamEvt.status === 200 && teamEvt.json?.success === true,
    `team-attributed event → ${teamEvt.status}`,
  );

  // Dashboard: manager sees aggregates; member gets 403.
  const dash = await req(`/api/team/dashboard?team_id=${teamId}`, { token: managerToken });
  expect(
    "manager dashboard",
    dash.status === 200 && typeof dash.json?.avg_score === "number",
    `GET /api/team/dashboard → ${dash.status} (avg=${dash.json?.avg_score})`,
  );
  const dash403 = await req(`/api/team/dashboard?team_id=${teamId}`, { token: memberToken });
  expect(
    "member dashboard 403",
    dash403.status === 403,
    `member dashboard → ${dash403.status} (expected 403)`,
  );
}

// ---------------------------------------------------------------------------
// 5. Shared library (spec §5.6): save → dedupe → list → get → version → governance
// ---------------------------------------------------------------------------
step("5. Library: save, dedupe, list, get, versioning, governance");
{
  const save = await req("/api/library", {
    method: "POST",
    token: managerToken,
    body: {
      team_id: teamId,
      title: "Sales summary prompt",
      prompt_text: PROMPT_TEXT,
      tags: ["sales", "summary"],
      score: 72,
    },
  });
  expect(
    "save",
    save.status === 201 && save.json?.id,
    `POST /api/library → ${save.status} (${save.json?.id})`,
  );
  promptId = save.json?.id;

  const dup = await req("/api/library", {
    method: "POST",
    token: managerToken,
    body: { team_id: teamId, prompt_text: PROMPT_TEXT },
  });
  expect("dedupe", dup.status === 409, `duplicate save → ${dup.status} (expected 409)`);

  const list = await req(`/api/library?team_id=${teamId}`, { token: managerToken });
  expect(
    "list",
    list.status === 200 && list.json?.prompts?.some((p) => p.id === promptId),
    `GET /api/library → ${list.status} (${list.json?.total ?? 0} prompts)`,
  );

  const get = await req(`/api/library/${promptId}`, { token: managerToken });
  expect(
    "get (decrypted)",
    get.status === 200 && get.json?.prompt_text === PROMPT_TEXT,
    `GET /api/library/{id} → ${get.status} (decrypt round-trip ok)`,
  );

  // Edit → new version preserving the original.
  const edited = `${PROMPT_TEXT} — with bullet points`;
  const patch = await req(`/api/library/${promptId}`, {
    method: "PATCH",
    token: managerToken,
    body: { prompt_text: edited, score: 85 },
  });
  expect(
    "edit versions",
    patch.status === 200 && patch.json?.version === 2,
    `PATCH /api/library/{id} → ${patch.status} (version=${patch.json?.version})`,
  );

  const versions = await req(`/api/library/${promptId}/versions`, { token: managerToken });
  expect(
    "versions list",
    versions.status === 200 && versions.json?.versions?.length >= 2,
    `GET /api/library/{id}/versions → ${versions.status} (${versions.json?.versions?.length ?? 0} versions)`,
  );

  // Manager governance (notes + Team Standard); members are blocked.
  const gov = await req(`/api/library/${promptId}`, {
    method: "PATCH",
    token: managerToken,
    body: { notes: "Team standard for Q3", is_standard: true },
  });
  expect(
    "manager governance",
    gov.status === 200 && gov.json?.is_standard === true,
    `manager notes/standard → ${gov.status}`,
  );

  const gov403 = await req(`/api/library/${promptId}`, {
    method: "PATCH",
    token: memberToken,
    body: { is_standard: false },
  });
  expect(
    "member governance 403",
    gov403.status === 403,
    `member governance → ${gov403.status} (expected 403)`,
  );
}

// ---------------------------------------------------------------------------
// 6. Cleanup — remove this run's rows from the real RDS (FK-safe order)
// ---------------------------------------------------------------------------
step("6. Cleanup of test rows on RDS");
if (DATABASE_URL) {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    // Children first, then teams, then users (teams.created_by has no cascade).
    await client.query(
      `DELETE FROM suggestions_feedback WHERE user_id IN (
         SELECT id FROM users WHERE email = $1 OR email = $2)`,
      [MANAGER_EMAIL, MEMBER_EMAIL],
    );
    await client.query(
      `DELETE FROM library_prompts WHERE team_id IN (
         SELECT id FROM teams WHERE created_by IN (
           SELECT id FROM users WHERE email = $1 OR email = $2))`,
      [MANAGER_EMAIL, MEMBER_EMAIL],
    );
    await client.query(
      `DELETE FROM prompt_events WHERE user_id IN (
         SELECT id FROM users WHERE email = $1 OR email = $2) OR team_id IN (
         SELECT id FROM teams WHERE created_by IN (
           SELECT id FROM users WHERE email = $1 OR email = $2))`,
      [MANAGER_EMAIL, MEMBER_EMAIL],
    );
    await client.query(
      `DELETE FROM team_members WHERE user_id IN (
         SELECT id FROM users WHERE email = $1 OR email = $2)`,
      [MANAGER_EMAIL, MEMBER_EMAIL],
    );
    await client.query(
      `DELETE FROM teams WHERE created_by IN (
         SELECT id FROM users WHERE email = $1 OR email = $2)`,
      [MANAGER_EMAIL, MEMBER_EMAIL],
    );
    await client.query(`DELETE FROM users WHERE email = $1 OR email = $2`, [
      MANAGER_EMAIL,
      MEMBER_EMAIL,
    ]);
    // Also drop the anonymous event written in step 2 (hashed-only, no user).
    await client.query(`DELETE FROM prompt_events WHERE prompt_hash = $1`, [PROMPT_HASH]);
    pass("test rows removed from RDS");
  } catch (err) {
    fail("cleanup", `failed to clean up test rows: ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
} else {
  console.warn("   ⚠ DATABASE_URL not set — skipping cleanup (test rows remain in RDS)");
}

// ---------------------------------------------------------------------------
console.log(
  `\n${failures === 0 ? "JOURNEY PASS" : "JOURNEY FAIL"} — ${steps} steps, ${failures} failure(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
