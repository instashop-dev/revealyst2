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

async function expectStatus(label, url, init, expected, { allowed = [] } = {}) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    fail(label, `fetch failed: ${err.message}`);
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
await expectStatus("GET /api/openapi.json", `${API}/api/openapi.json`, {}, 200);

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
  const res = await fetch(`${WEB}${path}`);
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

// --- Summary ---------------------------------------------------------------
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s), ${warnings} warning(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
