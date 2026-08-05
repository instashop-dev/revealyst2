import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Static server for the Playwright mock-LLM pages (e2e only). */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mock-llm");

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const file = url.pathname === "/" ? "chatgpt.html" : url.pathname.slice(1);
    const content = await readFile(path.join(root, file));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(4174, "127.0.0.1", () => {
  console.log("mock LLM pages on http://127.0.0.1:4174");
});
