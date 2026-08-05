import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const archiver = require("archiver");

/**
 * Package the built extension (dist/) into revealyst-extension.zip
 * (pure-JS archiver — cross-platform).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "revealyst-extension.zip");
const dist = path.join(root, "dist");
rmSync(out, { force: true });
mkdirSync(dist, { recursive: true });

await new Promise((resolve, reject) => {
  const output = createWriteStream(out);
  const archive = archiver("zip", { zlib: { level: 9 } });
  output.on("close", resolve);
  archive.on("error", reject);
  archive.pipe(output);
  archive.directory(dist, false);
  void archive.finalize();
});

console.log(`Packaged ${out}`);
