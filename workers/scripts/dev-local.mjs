#!/usr/bin/env node
/**
 * Revealyst local dev launcher — `wrangler dev` that works out of the box.
 *
 * Usage:
 *   npm run dev:local -w workers                 # default: port 8788, 127.0.0.1
 *   npm run dev:local -w workers -- --port 8790  # pass-through wrangler args
 *
 * Why this exists:
 *   1. Wrangler 4.x reads `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
 *      (auth) and `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*`
 *      (Hyperdrive local emulation) from the PROCESS environment, not from
 *      `.dev.vars` — so plain `wrangler dev` fails with a stale/absent token
 *      or "no local hyperdrive connection string".
 *   2. The emulated Hyperdrive connection string MUST include
 *      `?sslmode=require` (see .dev.vars.example) or miniflare pipes
 *      plaintext to RDS and every query fails with
 *      `no pg_hba.conf entry for host ... no encryption`.
 *
 * This script loads those variables from `workers/.dev.vars` (falling back to
 * a root `.dev.vars`) and spawns `wrangler dev`. Everything else in
 * `.dev.vars` is still applied by wrangler itself, as usual.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workersDir = path.join(root, "workers");
const candidates = [
  process.env.REVEALYST_DEV_VARS,
  path.join(workersDir, ".dev.vars"),
  path.join(root, ".dev.vars"),
].filter(Boolean);

const varsFile = candidates.find((p) => existsSync(p));
if (!varsFile) {
  console.error(
    "dev:local — no .dev.vars found. Copy workers/.dev.vars.example to workers/.dev.vars and fill it in.",
  );
  process.exit(1);
}

/** Parse a dotenv-style file into a plain object (last value wins, no interpolation). */
function parseDotEnv(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return acc;
      const i = trimmed.indexOf("=");
      acc[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
      return acc;
    }, {});
}

const vars = parseDotEnv(varsFile);

// Vars that must reach the process env (auth + Hyperdrive emulation).
const REQUIRED_ENV = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k] && !vars[k]);
if (missing.length > 0) {
  console.warn(
    `dev:local — missing in ${path.relative(root, varsFile)}: ${missing.join(", ")} ` +
      `(Hyperdrive emulation/auth will not work until these are set)`,
  );
}
for (const key of REQUIRED_ENV) {
  if (!process.env[key] && vars[key]) process.env[key] = vars[key];
}

const extraArgs = process.argv.slice(2);
if (!extraArgs.includes("--port")) extraArgs.push("--port", "8788");
if (!extraArgs.includes("--ip")) extraArgs.push("--ip", "127.0.0.1");

console.log(`dev:local — using vars from ${path.relative(root, varsFile)}`);
console.log(`dev:local — wrangler dev ${extraArgs.join(" ")} (cwd: workers/)`);

// Resolve wrangler's CLI entry directly (pinned root devDependency) and run it
// with `node` — fully cross-platform, no npx/.cmd resolution, no shell arg
// concatenation. Falls back to `npx` when the local install is absent.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let wranglerBin;
try {
  // `wrangler` resolves (via package.json main/exports) to wrangler-dist/cli.js,
  // which is directly runnable with node — the bin shim only adds --no-warnings.
  wranglerBin = require.resolve("wrangler");
} catch {
  wranglerBin = null;
}

const child = wranglerBin
  ? spawn(process.execPath, [wranglerBin, "dev", ...extraArgs], {
      cwd: workersDir,
      stdio: "inherit",
    })
  : // No local install: fall back to `npx` (Windows needs npx.cmd + shell).
    spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "dev", ...extraArgs], {
      cwd: workersDir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on("error", (err) => {
  console.error(`dev:local — failed to spawn wrangler: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
