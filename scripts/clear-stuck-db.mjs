// Ops diagnostic + cleanup: inspect RDS connection activity and terminate
// stale backends left by hung worker requests (e.g. leaked pools). Reads the
// git-ignored `workers/.dev.vars` (fallback: root `.dev.vars`) for
// DATABASE_URL, and forces TLS (RDS rejects plaintext connections).
// Run: node scripts/clear-stuck-db.mjs
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const varsFile = [path.join(root, "workers", ".dev.vars"), path.join(root, ".dev.vars")].find(
  existsSync,
);
if (!varsFile) {
  console.error(".dev.vars not found (looked in workers/ and repo root)");
  process.exit(1);
}
const vars = Object.fromEntries(
  readFileSync(varsFile, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
let url = vars.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL missing from .dev.vars");
  process.exit(1);
}
// RDS requires TLS; postgres.js honors sslmode=require in the connection
// string (plaintext is rejected with "no pg_hba.conf entry ... no encryption").
if (!/sslmode=/.test(url)) url += (url.includes("?") ? "&" : "?") + "sslmode=require";

const { default: postgres } = await import(
  pathToFileURL(path.join(root, "node_modules/postgres/src/index.js")).href
);
const sql = postgres(url, {
  connect_timeout: 10,
  idle_timeout: 10,
  max: 2,
  prepare: false,
});

async function snapshot(label) {
  const rows = await sql.unsafe(
    `SELECT pid, usename, application_name, state,
            now() - state_change AS state_age,
            left(coalesce(query,''), 60) AS query
     FROM pg_stat_activity
     WHERE datname = current_database()
     ORDER BY state_change NULLS LAST`,
  );
  console.log(`\n--- ${label} (${rows.length} connections) ---`);
  for (const r of rows) {
    console.log(
      `${r.pid} ${r.usename} app=${r.application_name ?? "-"} state=${r.state ?? "-"} ` +
        `state_age=${r.state_age} q=${r.query}`,
    );
  }
  return rows;
}

await snapshot("BEFORE");

const rows = await sql.unsafe(
  `SELECT pid, application_name, state, now() - state_change AS state_age
   FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
);
const targets = rows.filter((r) => {
  const app = (r.application_name ?? "").toLowerCase();
  const isWorkerLike =
    app.includes("postgres.js") || app.includes("revealyst") || app.includes("hyperdrive");
  const idleInTxn = r.state === "idle in transaction";
  const staleIdle =
    (r.state === "idle" || r.state === "idle in transaction") &&
    typeof r.state_age === "string" &&
    parseAgeSeconds(r.state_age) > 600;
  return isWorkerLike || idleInTxn || staleIdle;
});

console.log(`\nTerminating ${targets.length} stale backends (self pid excluded):`);
for (const t of targets) {
  console.log(`  kill ${t.pid} app=${t.application_name ?? "-"} state=${t.state ?? "-"}`);
  await sql
    .unsafe("SELECT pg_terminate_backend($1)", [t.pid])
    .catch((e) => console.log(`    -> failed: ${e.message}`));
}

await snapshot("AFTER");
await sql.end({ timeout: 3 });

function parseAgeSeconds(age) {
  // Postgres interval like "00:03:12.5" or "1 day 02:03:04"
  const m = age.match(/(?:(\d+) days? )?(\d+):(\d+):([\d.]+)/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}
