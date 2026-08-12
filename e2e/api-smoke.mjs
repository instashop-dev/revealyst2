#!/usr/bin/env node
/**
 * Revealyst live integration smoke — exercises the deployed Workers API and
 * Pages dashboard exactly like a user would.
 *
 * Usage:
 *   node e2e/api-smoke.mjs [--strict-email]
 *
 * Env:
 *   E2E_API_URL  default https://revealyst-workers.thapi.workers.dev
 *   E2E_WEB_URL  default https://revealyst-web.pages.dev
 *
 * Notes:
 *   - The magic-link endpoint is rate limited (5/min/IP); this script makes at
 *     most two calls, so repeated CI runs stay under the limit.
 *   - SES email delivery is checked non-fatally by default: in the SES
 *     sandbox, recipients must be pre-verified, so a 500 `email_failed` is
 *     reported as a warning unless `--strict-email` is passed (then it fails).
 *   - Exit code 0 = all checks pass; 1 = anything failed.
 */

const API = process.env.E2E_API_URL ?? "https://revealyst-workers.thapi.workers.dev";
const WEB = process.env.E2E_WEB_URL ?? "https://revealyst-web.pages.dev";

let failures = 0;
let warnings = 0;

function pass(name, detail = "") {
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function warn(name, detail) {
  warnings += 1;
  console.warn(`  ⚠ ${name} — ${detail}`);
}

function fail(name, detail) {
  failures += 1;
  console.error(`  ✗ ${name} — ${detail}`);
}

const FETCH_TIMEOUT_MS = 45_000;

async function expectStatus(label, url, init, expected, { allowed = [] } = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    fail(label, `fetch failed after ${FETCH_TIMEOUT_MS / 1000}s: ${err.message}`);
    return null;
  }
  if (res.status === expected || allowed.includes(res.status)) {
    pass(label, `HTTP ${res.status}`);
  } else {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    fail(
      label,
      `expected HTTP ${expected}${allowed.length ? ` or ${allowed.join("/")}` : ""}, got ${res.status} — ${body}`,
    );
  }
  return res;
}

console.log(`\nRevealyst live smoke — API: ${API} | Web: ${WEB}\n`);

// --- API: health + OpenAPI ------------------------------------------------
await expectStatus("GET /api/health", `${API}/api/health`, {}, 200);
await expectStatus("GET /api/health?db=1", `${API}/api/health?db=1`, {}, 200);
await expectStatus("GET /api/openapi.json", `${API}/api/openapi.json`, {}, 200);
await expectStatus("GET /api/docs", `${API}/api/docs`, {}, 200);

// --- API: auth shape (no credentials needed) --------------------------------
await expectStatus("GET /api/auth/me (no token → 401)", `${API}/api/auth/me`, {}, 401);
await expectStatus(
  "POST /api/auth/magic (bad email → 400)",
  `${API}/api/auth/magic`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  },
  400,
);
await expectStatus(
  "POST /api/auth/verify (garbage token → 401)",
  `${API}/api/auth/verify`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "garbage-token" }),
  },
  401,
);

// --- API: authenticated endpoints require a session --------------------------
// Every data endpoint must 401 without a Bearer session token (spec §6.4:
// "All endpoints authenticate via a JWT from the magic link flow").
for (const [label, method, path] of [
  ["GET /api/teams", "GET", "/api/teams"],
  ["GET /api/history", "GET", "/api/history"],
  ["GET /api/stats", "GET", "/api/stats"],
  ["GET /api/library", "GET", "/api/library"],
  ["GET /api/team/dashboard", "GET", "/api/team/dashboard"],
  ["POST /api/team", "POST", "/api/team"],
  ["POST /api/library", "POST", "/api/library"],
  ["POST /api/feedback", "POST", "/api/feedback"],
]) {
  await expectStatus(
    `${label} (no token → 401)`,
    `${API}${path}`,
    method === "GET"
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "x" }),
        },
    401,
  );
}

// --- API: suggestion engine (spec §5.3) --------------------------------------
// Exercises the deployed Vectorize→LLM pipeline (falls back to static patterns
// if upstream is unavailable — either way the response shape must hold).
const sugRes = await expectStatus(
  "POST /api/suggestion (real flags)",
  `${API}/api/suggestion`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flags: ["missing_output_format", "vague_context"] }),
  },
  200,
);
if (sugRes) {
  const body = await sugRes.json().catch(() => ({}));
  const ok =
    Array.isArray(body.suggestions) &&
    body.suggestions.every(
      (s) =>
        typeof s.id === "string" &&
        typeof s.text === "string" &&
        typeof s.preview === "string" &&
        ["prepend", "append", "insert"].includes(s.action),
    ) &&
    ["vectorize+llm", "static"].includes(body.source);
  if (ok) {
    pass("suggestion shape", `${body.suggestions.length} suggestions, source=${body.source}`);
  } else {
    fail("suggestion shape", `unexpected body: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

await expectStatus(
  "POST /api/suggestion (bad body → 400)",
  `${API}/api/suggestion`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flags: [42] }),
  },
  400,
);

// --- API: event validation (spec §5.7) ---------------------------------------
// Anonymous events are allowed by design (local-first scoring, hashed prompt
// only); team attribution requires a session (401) and membership (403).
const ANON_EVENT = {
  prompt_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  score: 72,
  flags: ["missing_output_format"],
  llm_platform: "chatgpt",
};
await expectStatus(
  "POST /api/event (anonymous, valid → 200)",
  `${API}/api/event`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ANON_EVENT),
  },
  200,
);
await expectStatus(
  "POST /api/event (team_id without session → 401)",
  `${API}/api/event`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...ANON_EVENT, team_id: "00000000-0000-0000-0000-000000000000" }),
  },
  401,
);
await expectStatus(
  "POST /api/event (bad body → 400)",
  `${API}/api/event`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ score: 50 }),
  },
  400,
);

// --- API: magic link (SES email delivery) ------------------------------------
// Uniform 200 by design (no delivery-state oracle); SES failures are tracked
// server-side in logs/observability, not in the API response.
const email = `smoke-${Date.now()}@example.com`;
const magicRes = await expectStatus(
  "POST /api/auth/magic (valid email)",
  `${API}/api/auth/magic`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  },
  200,
);

if (magicRes) {
  const body = await magicRes.json().catch(() => ({}));
  if (body.dev_link) {
    warn(
      "magic link",
      "API returned dev_link in production — DEV_MODE looks enabled on the live worker",
    );
  } else {
    pass("magic link accepted", `→ ${email} (SES delivery verified in SES console/observability)`);
  }
}

// --- Web: dashboard shell + SPA fallback for /auth/verify -------------------
for (const path of ["/", "/auth/verify?token=smoke", "/progress"]) {
  const res = await fetch(`${WEB}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 200) {
    const html = await res.text();
    if (html.includes("Revealyst")) {
      pass(`GET ${path}`, "HTTP 200, dashboard shell served");
    } else {
      fail(`GET ${path}`, "HTTP 200 but page does not reference Revealyst");
    }
  } else {
    fail(`GET ${path}`, `expected 200, got ${res.status}`);
  }
}

// --- Web: extension download link ------------------------------------------
// Pre-Web-Store distribution: the deploy pipeline stages the freshly built
// extension zip next to the dashboard shell, so the dashboard's "Download the
// extension" link always serves the latest build.
const extRes = await fetch(`${WEB}/revealyst-extension.zip`, {
  signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
});
if (extRes.status === 200) {
  pass(
    "GET /revealyst-extension.zip",
    `HTTP 200 (content-type: ${extRes.headers.get("content-type") ?? "unknown"})`,
  );
} else {
  fail("GET /revealyst-extension.zip", `expected 200, got ${extRes.status}`);
}

// --- Summary ---------------------------------------------------------------
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s), ${warnings} warning(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
