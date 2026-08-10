/**
 * Synthetic prompt corpus generator for the ONNX prompt scorer (spec §5.2).
 *
 * Produces a deterministic, rule-labeled corpus by:
 *   - filling hand-authored sentence templates (realistic prompts),
 *   - assembling feature blocks (audience, purpose, role, format, examples,
 *     concrete signals, constraints),
 *   - degrading assembled prompts (dropping parts),
 *   - adding edge cases (empty / too short / >4000-char truncated).
 *
 * Labels come from @revealyst/scoring's RuleScoringEngine: the trained model
 * is a distillation of the rules until human-labeled beta data exists (see
 * docs/ml-notes.md). The generator is fully deterministic (seeded PRNG), so
 * `npm run generate:corpus -w ml` reproduces the exact same corpus every run.
 *
 * Usage:
 *   npm run generate:corpus -w ml [-- --seed 42 --train 6000 --eval 1500 --out data]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RuleScoringEngine } from "@revealyst/scoring";
import type { ScoreResult } from "@revealyst/scoring";

export interface CorpusRow {
  id: string;
  split: "train" | "eval";
  prompt: string;
  score: number;
  breakdown: ScoreResult["breakdown"];
  flags: string[];
  meta: {
    wordCount: number;
    charCount: number;
    estimatedTokens: number;
    truncated: boolean;
  };
}

export interface GenerateOptions {
  seed?: number;
  train?: number;
  eval?: number;
}

/* ------------------------------------------------------------------ *
 * Seeded PRNG (mulberry32) — the whole corpus is reproducible.        *
 * ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], rnd: () => number): T {
  const item = items[Math.floor(rnd() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

function chance(p: number, rnd: () => number): boolean {
  return rnd() < p;
}

/* ------------------------------------------------------------------ *
 * Content pools                                                       *
 * ------------------------------------------------------------------ */

const TASKS = [
  "Write",
  "Draft",
  "Create",
  "Explain",
  "Summarize",
  "Plan",
  "Review",
  "Rewrite",
  "Compare",
  "List",
] as const;

const CONTENT_TYPES = [
  "email",
  "landing page copy",
  "blog post",
  "LinkedIn post",
  "sales pitch",
  "onboarding guide",
  "FAQ",
  "product description",
  "social media caption",
  "press release",
] as const;

const TOPICS = [
  "Acme's Q3 launch",
  "the LaunchFest campaign",
  "Promptly (our new AI assistant)",
  "migrating to AWS",
  "the 2026 marketing plan",
  "our new onboarding flow",
  "the pricing change in October",
  "the customer feedback survey results",
  "our upcoming webinar series",
  "the enterprise security features",
] as const;

const AUDIENCES = [
  "for my team of 6 marketers",
  "for beginners",
  "for our CTO",
  "for a client in fintech",
  "aimed at senior executives",
  "for first-time users",
  "for a 15-person agency",
  "for sales reps who hate jargon",
  "for non-technical stakeholders",
  "for our customers in Europe",
] as const;

const PURPOSES = [
  "so that we can increase conversions by 15%",
  "in order to reduce support tickets",
  "to prepare for the Q3 board meeting",
  "to teach new hires the workflow",
  "to convince investors to fund us",
  "so that customers understand the new pricing",
  "to get 200 signups this month",
  "to align the team before launch",
] as const;

const BACKGROUNDS = [
  "We are a 15-person agency",
  "I currently work in customer support",
  "As part of the Promptly project",
  "Our product is a browser extension called Revealyst",
  "We just migrated to AWS",
  "Our team uses Slack and Notion",
  "I am the product manager for Promptly",
] as const;

const CONSTRAINTS = [
  "within 500 words",
  "at least 3 bullet points",
  "must include pricing",
  "no more than 2 pages",
  "under 10 minutes to read",
  "with a call to action",
  "in a friendly tone",
  "using plain language",
] as const;

const ROLES = [
  "Act as a content strategist",
  "You are an experienced copywriter",
  "Assume the role of a customer support lead",
  "Your job is to act as a sales engineer",
  "Imagine you are a product manager",
  "Pretend you are a data analyst",
  "As a senior UX writer",
  "Act as an SEO specialist",
] as const;

const FORMATS = [
  "in JSON",
  "as a markdown table",
  "with bullet points",
  "as a numbered list",
  "as an outline",
  "in the form of an email",
  "as a structured report with headings",
  "as a CSV",
  "in YAML",
] as const;

const EXAMPLES = [
  "For example: 'Our new pricing starts at $9 per month'",
  "For instance, 'Use the template attached to this ticket'",
  "e.g. 'Q3: +23% signups, 4.8 star rating'",
  "such as 'We saved 40 hours per month'",
  "Here's an example: 'Subject: Your October invoice is ready'",
  "Given the following input: 'low engagement' → output: '5 re-engagement tactics'",
] as const;

const VAGUE = [
  "make it better",
  "do it properly",
  "something nice",
  "help me with my thing",
  "good stuff",
  "basically improve it",
  "kind of like that",
  "sort of what we discussed",
] as const;

/** Concrete signals the rules reward (numbers, %, $, URLs, @mentions). */
const CONCRETE = [
  "15%",
  "$9 per month",
  "500 words",
  "6 items",
  "Q3",
  "2026",
  "https://example.com/promptly",
  "@jane",
] as const;

/* ------------------------------------------------------------------ *
 * Prompt builders                                                     *
 * ------------------------------------------------------------------ */

function fill(template: string, rnd: () => number): string {
  return template
    .replaceAll("{task}", pick(TASKS, rnd))
    .replaceAll("{contentType}", pick(CONTENT_TYPES, rnd))
    .replaceAll("{topic}", pick(TOPICS, rnd))
    .replaceAll("{audience}", pick(AUDIENCES, rnd))
    .replaceAll("{purpose}", pick(PURPOSES, rnd))
    .replaceAll("{background}", pick(BACKGROUNDS, rnd))
    .replaceAll("{constraint}", pick(CONSTRAINTS, rnd))
    .replaceAll("{role}", pick(ROLES, rnd))
    .replaceAll("{format}", pick(FORMATS, rnd))
    .replaceAll("{example}", pick(EXAMPLES, rnd))
    .replaceAll("{vague}", pick(VAGUE, rnd));
}

/** Hand-authored realistic templates, spread across score bands. */
const TEMPLATES: readonly string[] = [
  // High-band templates: role + audience + purpose + format + example.
  "{role} {audience}. {task} a {contentType} about {topic}, so that we can {purpose}. Format it {format} and include {example}. {constraint}.",
  "{task} a {contentType} about {topic}. Use {format}. For example: 'Keep it under 500 words'. For instance, 'Include one concrete metric per claim'. Here's an example: 'We cut response time by 30%'.",
  "You are an experienced copywriter. We are a 15-person agency launching Promptly. Draft a {contentType} for {audience} that explains {topic}, aimed at increasing conversions by 15%. Use {format}, within 500 words. {example}.",
  "Assume the role of a product manager. Our product is Revealyst, and we need a {contentType} for {audience} about {topic}, so that {purpose}. Structure it {format} with a call to action. {example}.",
  "{task} a {contentType} about {topic} {audience} in {format}, including {example}. Make sure it is {constraint}.",
  // Mid-band templates: some signals, missing others.
  "{task} {topic} {audience}.",
  "{task} {contentType} about {topic}.",
  "Summarize this article about {topic}: https://example.com/blog/{topic}.",
  "Write 6 ideas for {topic} {format}.",
  // Low-band templates: vague or minimal.
  "help me with this",
  "make it better",
  "write about stuff",
  "can you do my thing for me thanks",
  "{task} something about {topic}",
  "improve my draft please",
  "{task} {vague}",
];

/** Assemble a prompt from independent feature blocks (combinatorial space). */
function buildAssembled(rnd: () => number): string {
  const parts: string[] = [];
  if (chance(0.55, rnd)) parts.push(pick(ROLES, rnd));
  if (chance(0.5, rnd)) parts.push(pick(BACKGROUNDS, rnd).toLowerCase());
  parts.push(
    `${pick(TASKS, rnd).toLowerCase()} a ${pick(CONTENT_TYPES, rnd)} about ${pick(TOPICS, rnd)}`,
  );
  if (chance(0.6, rnd)) parts.push(pick(AUDIENCES, rnd));
  if (chance(0.55, rnd)) parts.push(pick(PURPOSES, rnd));
  if (chance(0.45, rnd)) parts.push(pick(FORMATS, rnd));
  if (chance(0.4, rnd)) parts.push(pick(EXAMPLES, rnd));
  // Some prompts carry 2-3 example markers → higher examples_included bands.
  if (chance(0.25, rnd)) parts.push(pick(EXAMPLES, rnd));
  if (chance(0.1, rnd)) parts.push(pick(EXAMPLES, rnd));
  if (chance(0.4, rnd)) parts.push(pick(CONSTRAINTS, rnd));
  if (chance(0.35, rnd)) parts.push(pick(CONCRETE, rnd));
  if (chance(0.25, rnd)) parts.push(pick(VAGUE, rnd));
  // Capitalize the first letter.
  const joined = parts.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** Strip quality signals from an assembled prompt → lower bands. */
function degrade(prompt: string, rnd: () => number): string {
  let out = prompt;
  if (chance(0.7, rnd)) {
    out = out.replace(/^Act as [^,]+, /i, "").replace(/^You are an? [^,]+, /i, "");
  }
  if (chance(0.7, rnd)) out = out.replace(/, in (JSON|YAML|CSV|markdown)[^,]*/i, "");
  if (chance(0.6, rnd))
    out = out.replace(/, (For example|For instance|e\.g\.|such as|Here's an example)[^.]*\./i, "");
  if (chance(0.5, rnd)) out = out.replace(/, (so that|in order to)[^,]*/i, "");
  return out;
}

const LONG_EMAIL_BODY =
  "We are writing to let you know that pricing is changing on October 1st. " +
  "Your current plan will be updated to reflect the new rates, and we want to " +
  "make sure you have all the details before the switch. ";

/** Edge prompts: empty, tiny, and one >4000-char prompt that must truncate. */
const EDGE_PROMPTS: readonly string[] = [
  "",
  "do it",
  "help",
  "write",
  "thanks",
  "asap",
  "Improve this email for our customers about the Q3 price change. Draft: " +
    LONG_EMAIL_BODY.repeat(120),
];

/* ------------------------------------------------------------------ *
 * Generation                                                          *
 * ------------------------------------------------------------------ */

function label(
  engine: RuleScoringEngine,
  prompt: string,
): {
  score: number;
  breakdown: ScoreResult["breakdown"];
  flags: string[];
  meta: CorpusRow["meta"];
} {
  const r = engine.scoreSync(prompt);
  return {
    score: r.score,
    breakdown: r.breakdown,
    flags: r.flags.map((f) => f.toString()),
    meta: {
      wordCount: r.meta.wordCount,
      charCount: r.meta.charCount,
      estimatedTokens: r.meta.estimatedTokens,
      truncated: r.meta.truncated,
    },
  };
}

function makePrompt(i: number, rnd: () => number): string {
  // Deterministic mix: 40% templates, 40% assembled, 15% degraded, 5% edges.
  const roll = rnd();
  if (roll < 0.4) return fill(pick(TEMPLATES, rnd), rnd);
  if (roll < 0.8) return buildAssembled(rnd);
  if (roll < 0.95) return degrade(buildAssembled(rnd), rnd);
  return EDGE_PROMPTS[i % EDGE_PROMPTS.length] ?? "";
}

export function generateCorpus(options: GenerateOptions = {}): CorpusRow[] {
  const { seed = 42, train = 6000, eval: evalCount = 1500 } = options;
  const engine = new RuleScoringEngine();
  const rnd = mulberry32(seed);
  const total = train + evalCount;
  const rows: CorpusRow[] = [];
  for (let i = 0; i < total; i++) {
    const prompt = makePrompt(i, rnd);
    const labeled = label(engine, prompt);
    rows.push({
      id: `prompt-${i}`,
      split: "train",
      prompt,
      score: labeled.score,
      breakdown: labeled.breakdown,
      flags: labeled.flags,
      meta: labeled.meta,
    });
  }
  // Deterministic shuffle, then 80/20 train/eval split (eval stays untouched
  // by training — same split every run for the same seed).
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = rows[i];
    if (tmp === undefined || rows[j] === undefined) continue;
    rows[i] = rows[j];
    rows[j] = tmp;
  }
  const evalSplit = Math.min(evalCount, rows.length);
  for (let i = 0; i < evalSplit; i++) {
    const row = rows[i];
    if (row) row.split = "eval";
  }
  // Guarantee edge coverage: overwrite the last N train rows with the edge
  // set, so every corpus contains empty/tiny/truncated prompts (deterministic
  // for a given seed; keeps the train/eval split sizes exact).
  const trainRows = rows.filter((r) => r.split === "train");
  const edges = EDGE_PROMPTS.slice();
  for (let i = 0; i < Math.min(edges.length, trainRows.length); i++) {
    const row = trainRows[trainRows.length - 1 - i];
    if (!row) continue;
    row.prompt = edges[i] ?? "";
    const relabeled = label(engine, row.prompt);
    row.score = relabeled.score;
    row.breakdown = relabeled.breakdown;
    row.flags = relabeled.flags;
    row.meta = relabeled.meta;
  }
  return rows;
}

export function summarize(rows: CorpusRow[]): string {
  const scores = rows.map((r) => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const trainCount = rows.filter((r) => r.split === "train").length;
  const evalCount = rows.length - trainCount;
  const truncated = rows.filter((r) => r.meta.truncated).length;
  const dims = (Object.keys(rows[0]?.breakdown ?? {}) as Array<keyof CorpusRow["breakdown"]>)
    .map(
      (d) =>
        `${d}=${Math.min(...rows.map((r) => r.breakdown[d]))}..${Math.max(...rows.map((r) => r.breakdown[d]))}`,
    )
    .join(", ");
  return [
    `corpus: ${rows.length} prompts (train ${trainCount}, eval ${evalCount})`,
    `score range: ${min}..${max} (mean ${mean.toFixed(1)})`,
    `dimension ranges: ${dims}`,
    `truncated (>4000 tokens): ${truncated}`,
  ].join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const get = (name: string): number | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : undefined;
  };
  const seed = get("--seed") ?? 42;
  const train = get("--train") ?? 6000;
  const evalCount = get("--eval") ?? 1500;
  const outDir = args[args.indexOf("--out") + 1] ?? "data";

  const rows = generateCorpus({ seed, train, eval: evalCount });
  const outDirAbs = join(fileURLToPath(new URL(".", import.meta.url)), "..", outDir);
  mkdirSync(outDirAbs, { recursive: true });
  const write = (split: "train" | "eval", file: string): void => {
    const lines = rows.filter((r) => r.split === split).map((r) => JSON.stringify(r));
    writeFileSync(join(outDirAbs, file), lines.join("\n") + "\n");
  };
  write("train", "corpus.jsonl");
  write("eval", "eval.jsonl");
  console.log(`[ml] wrote ml/${outDir}/corpus.jsonl + eval.jsonl (seed ${seed})`);
  console.log(summarize(rows));
}

// Run directly: `node src/generate-corpus.ts` (Node >= 23.6 strips types).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
