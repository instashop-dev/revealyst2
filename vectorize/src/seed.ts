import { generatePatterns } from "./generate.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 100;

/**
 * Seed CLI: generate ~5,000 patterns, embed them with OpenAI
 * text-embedding-3-small, and upsert them into the Cloudflare Vectorize
 * namespace via the REST API (spec §6.3). The namespace must already exist:
 *
 *   npx wrangler vectorize create prompt-patterns --dimensions=1536 --metric=cosine
 *
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, OPENAI_API_KEY,
 *      VECTORIZE_NAMESPACE (default "prompt-patterns").
 */
async function main(): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const openAiKey = process.env.OPENAI_API_KEY;
  const namespace = process.env.VECTORIZE_NAMESPACE ?? "prompt-patterns";
  if (!token || !accountId || !openAiKey) {
    console.error("Missing env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, OPENAI_API_KEY");
    process.exit(1);
  }

  const patterns = generatePatterns();
  console.log(`Generated ${patterns.length} patterns for namespace "${namespace}"`);

  const embeddings = new Map<string, number[]>();
  for (let offset = 0; offset < patterns.length; offset += BATCH_SIZE) {
    const batch = patterns.slice(offset, offset + BATCH_SIZE);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openAiKey}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch.map((p) => p.pattern_text) }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`embedding failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
    for (const item of data.data) {
      const pattern = batch[item.index];
      if (pattern) embeddings.set(pattern.id, item.embedding);
    }
    console.log(`  embedded ${offset + batch.length}/${patterns.length}`);
  }

  for (let offset = 0; offset < patterns.length; offset += BATCH_SIZE) {
    const vectors = patterns.slice(offset, offset + BATCH_SIZE).map((p) => ({
      id: p.id,
      values: embeddings.get(p.id),
      metadata: {
        pattern_text: p.pattern_text,
        preview: p.preview,
        category: p.category,
        fixes_flags: p.fixes_flags,
        priority: p.priority,
      },
    }));
    const body = JSON.stringify({ vectors });
    // Vectorize v2 REST; falls back to the legacy v1 path if the account uses it.
    const urls = [
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${namespace}/upsert`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/indexes/${namespace}/upsert`,
    ];
    let ok = false;
    for (const url of urls) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
      if (res.ok) {
        ok = true;
        break;
      }
      const text = await res.text();
      console.warn(`upsert attempt failed (${res.status}) at ${url}: ${text.slice(0, 200)}`);
    }
    if (!ok) throw new Error(`vector upsert failed for batch ${offset}`);
    console.log(`  upserted ${offset + vectors.length}/${patterns.length}`);
  }

  console.log(`Seeded ${patterns.length} vectors into "${namespace}".`);
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
