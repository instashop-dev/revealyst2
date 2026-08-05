import { flagInfo } from "@revealyst/scoring";
import type { VectorizeIndex } from "@cloudflare/workers-types";
import type { WorkerEnv } from "./env.js";

export type SuggestionAction = "prepend" | "append" | "insert";

export interface Suggestion {
  id: string;
  type: string;
  text: string;
  preview: string;
  action: SuggestionAction;
}

export interface PromptPattern {
  id: string;
  category: string;
  pattern_text: string;
  preview: string;
  fixes_flags: string[];
  priority: number;
}

export interface SuggestionResult {
  suggestions: Suggestion[];
  source: "vectorize+llm" | "static";
}

const EMBEDDING_MODEL = "text-embedding-3-small";
const SUGGESTION_MODEL = "gpt-4o-mini";

const LLM_SYSTEM_PROMPT = `You are the suggestion engine of Revealyst, an AI prompt coaching tool.
Given the deficiencies of a user's prompt and up to 3 retrieved prompt-improvement patterns, produce
a JSON object with a "suggestions" array of at most 3 actionable, one-click suggestions.
Each suggestion must have exactly these string fields:
- "id": a kebab-case stable id (e.g. "add_role", "add_output_format")
- "type": the pattern category (e.g. "add_role")
- "text": a short human explanation of what to add and why
- "preview": the exact text that will be inserted into the user's prompt (no placeholders, ready to paste)
- "action": one of "prepend", "append", "insert"
Return only valid JSON, nothing else.`;

/**
 * The suggestions pipeline (spec §5.3): flags → deficiency description →
 * OpenAI embedding → Vectorize top-3 patterns → GPT-4o-mini suggestions.
 * Falls back to deterministic static patterns when any upstream fails, and to
 * generic tips when even the static set has nothing (spec §7: retry once,
 * then fall back).
 */
export async function getSuggestions(flags: string[], env: WorkerEnv): Promise<SuggestionResult> {
  const deficiencies = flags.length > 0 ? flags : ["low_specificity"];
  const queryText = describeDeficiency(deficiencies);

  try {
    const vector = await withRetry(() => embed(queryText, env.OPENAI_API_KEY));
    if (!env.VECTORIZE) throw new Error("VECTORIZE binding unavailable");
    const patterns = await queryPatterns(env.VECTORIZE, vector);
    if (patterns.length === 0) throw new Error("no patterns matched");
    const suggestions = await withRetry(() =>
      generateSuggestions(patterns, deficiencies, env.OPENAI_API_KEY),
    );
    return { suggestions, source: "vectorize+llm" };
  } catch {
    const suggestions = selectStaticPatterns(deficiencies).map(patternToSuggestion);
    return { suggestions: suggestions.length > 0 ? suggestions : GENERIC_TIPS, source: "static" };
  }
}

/** "Fix a prompt that is missing output format and has vague context." */
export function describeDeficiency(flags: string[]): string {
  const labels = flags.map((f) => flagInfo(f)?.description ?? f.replace(/_/g, " ")).filter(Boolean);
  if (labels.length === 0) return "Improve the prompt quality.";
  const head = labels.slice(0, -1).join(", ");
  const tail = labels.length > 1 ? labels[labels.length - 1] : undefined;
  return `Fix a prompt that ${tail ? `${head} and ${tail}` : head}`.replace(
    /^Fix a prompt that /,
    "Fix a prompt that ",
  );
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function embed(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`embedding failed: ${res.status}`);
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = data.data[0]?.embedding;
  if (!embedding) throw new Error("embedding missing from response");
  return embedding;
}

async function queryPatterns(
  vectorize: VectorizeIndex,
  vector: number[],
): Promise<PromptPattern[]> {
  const result = await vectorize.query(vector, { topK: 3, returnMetadata: "all" });
  return (result.matches ?? [])
    .map((match) => match.metadata as unknown as PromptPattern)
    .filter((p) => p && typeof p.pattern_text === "string");
}

async function generateSuggestions(
  patterns: PromptPattern[],
  flags: string[],
  apiKey: string,
): Promise<Suggestion[]> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: SUGGESTION_MODEL,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: LLM_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Deficiencies: ${JSON.stringify(flags)}\nRetrieved patterns: ${JSON.stringify(patterns)}\n`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`suggestion generation failed: ${res.status}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { content?: string } }>;
  };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("empty suggestion response");
  const parsed = JSON.parse(content) as { suggestions?: unknown };
  return normalizeSuggestions(parsed.suggestions);
}

function normalizeSuggestions(raw: unknown): Suggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: Suggestion[] = [];
  for (const item of raw.slice(0, 3)) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "suggestion";
    const type = typeof r.type === "string" ? r.type : id;
    const text = typeof r.text === "string" ? r.text : "";
    const preview = typeof r.preview === "string" ? r.preview : "";
    const action: SuggestionAction =
      r.action === "prepend" || r.action === "append" || r.action === "insert"
        ? r.action
        : "prepend";
    if (!text || !preview) continue;
    out.push({ id, type, text, preview, action });
  }
  return out;
}

/** Deterministic fallback selection: most matching flags, then priority. */
export function selectStaticPatterns(flags: string[]): PromptPattern[] {
  const scored = STATIC_PATTERNS.map((pattern) => {
    const matches = pattern.fixes_flags.filter((f) => flags.includes(f)).length;
    return { pattern, matches };
  })
    .filter((entry) => entry.matches > 0)
    .sort((a, b) => b.matches - a.matches || a.pattern.priority - b.pattern.priority);

  // Spread across distinct deficiencies before repeating a category.
  const chosen: PromptPattern[] = [];
  const covered = new Set<string>();
  for (const { pattern } of scored) {
    const fixesNew = pattern.fixes_flags.some((f) => !covered.has(f));
    if (fixesNew || chosen.length < 3) {
      chosen.push(pattern);
      for (const f of pattern.fixes_flags) covered.add(f);
      if (chosen.length >= 3) break;
    }
  }
  return chosen.slice(0, 3);
}

function patternToSuggestion(pattern: PromptPattern): Suggestion {
  return {
    id: pattern.id,
    type: pattern.category,
    text: pattern.pattern_text,
    preview: pattern.preview,
    action: pattern.preview.startsWith(" ") ? "append" : "prepend",
  };
}

export const GENERIC_TIPS: Suggestion[] = [
  {
    id: "add_role",
    type: "add_role",
    text: 'Give the AI a role to anchor its expertise, e.g. "Act as a senior copywriter."',
    preview: "Act as a senior copywriter. ",
    action: "prepend",
  },
  {
    id: "add_output_format",
    type: "add_output_format",
    text: 'Tell the AI exactly how to respond, e.g. "Answer as a bulleted list."',
    preview: "Answer as a bulleted list. ",
    action: "append",
  },
  {
    id: "add_context",
    type: "add_context",
    text: "Add who it is for, why you need it, and what you already know.",
    preview: " For context: this is for my team, and I need it to plan next week.",
    action: "append",
  },
];

/**
 * Static prompt-improvement patterns — the rule-based fallback when
 * Vectorize/OpenAI are unreachable (spec §7). The production path uses
 * embeddings over ~5,000 seeded patterns in Vectorize (see vectorize/).
 */
export const STATIC_PATTERNS: PromptPattern[] = [
  {
    id: "p_role_1",
    category: "add_role",
    pattern_text: "Give the AI a defined expert role before the task.",
    preview: "Act as a senior marketing strategist. ",
    fixes_flags: ["missing_role"],
    priority: 1,
  },
  {
    id: "p_role_2",
    category: "add_role",
    pattern_text: "Frame the AI as a specialist with clear responsibilities.",
    preview: "You are a meticulous copy editor. ",
    fixes_flags: ["missing_role"],
    priority: 2,
  },
  {
    id: "p_role_3",
    category: "add_role",
    pattern_text: "Add a persona that matches the audience you are writing for.",
    preview: "As a B2B sales coach, ",
    fixes_flags: ["missing_role"],
    priority: 3,
  },
  {
    id: "p_role_4",
    category: "add_role",
    pattern_text: "Assign a role and a goal in one sentence.",
    preview: "Act as a data analyst and summarize the key insight. ",
    fixes_flags: ["missing_role"],
    priority: 4,
  },
  {
    id: "p_format_1",
    category: "add_output_format",
    pattern_text: "Specify the response structure explicitly.",
    preview: " Answer as a bulleted list.",
    fixes_flags: ["missing_output_format"],
    priority: 1,
  },
  {
    id: "p_format_2",
    category: "add_output_format",
    pattern_text: "Ask for a concrete output format such as JSON.",
    preview: " Return the result as valid JSON.",
    fixes_flags: ["missing_output_format"],
    priority: 2,
  },
  {
    id: "p_format_3",
    category: "add_output_format",
    pattern_text: "Add a length or structure constraint.",
    preview: " Respond in at most 150 words with a short heading.",
    fixes_flags: ["missing_output_format"],
    priority: 3,
  },
  {
    id: "p_format_4",
    category: "add_output_format",
    pattern_text: "Define the deliverable: table, outline, email, or checklist.",
    preview: " Present the answer as a markdown table.",
    fixes_flags: ["missing_output_format"],
    priority: 4,
  },
  {
    id: "p_ctx_1",
    category: "add_context",
    pattern_text: "Add background so the AI understands the situation.",
    preview: " For context: we are a small SaaS team and this is for our weekly newsletter.",
    fixes_flags: ["vague_context", "missing_context"],
    priority: 1,
  },
  {
    id: "p_ctx_2",
    category: "add_context",
    pattern_text: "Name the audience you are writing for.",
    preview: " This is aimed at non-technical small business owners.",
    fixes_flags: ["vague_context", "missing_context"],
    priority: 2,
  },
  {
    id: "p_ctx_3",
    category: "add_context",
    pattern_text: "State the goal so the answer fits its purpose.",
    preview: " My goal is to convince the reader to sign up for a free trial.",
    fixes_flags: ["vague_context", "missing_context"],
    priority: 3,
  },
  {
    id: "p_ctx_4",
    category: "add_context",
    pattern_text: "Mention what you already know or have tried.",
    preview: " We already tested two versions and want a third angle.",
    fixes_flags: ["vague_context"],
    priority: 4,
  },
  {
    id: "p_spec_1",
    category: "improve_specificity",
    pattern_text: "Replace vague words with concrete numbers and details.",
    preview: " Include at least three concrete examples with real numbers. ",
    fixes_flags: ["low_specificity"],
    priority: 1,
  },
  {
    id: "p_spec_2",
    category: "improve_specificity",
    pattern_text: "Add constraints like length, tone, and must-haves.",
    preview: " Keep it under 100 words with a friendly, confident tone. ",
    fixes_flags: ["low_specificity"],
    priority: 2,
  },
  {
    id: "p_spec_3",
    category: "improve_specificity",
    pattern_text: "Name the exact topic instead of describing it vaguely.",
    preview: " Focus specifically on onboarding flows for new users. ",
    fixes_flags: ["low_specificity"],
    priority: 3,
  },
  {
    id: "p_ex_1",
    category: "add_examples",
    pattern_text: "Add an example so the AI matches the expected style.",
    preview: " For example: like this — \u201cTurn every prompt into a step forward.\u201d ",
    fixes_flags: ["no_examples"],
    priority: 1,
  },
  {
    id: "p_ex_2",
    category: "add_examples",
    pattern_text: "Show an input/output pair as a template.",
    preview: " Example input: ... / Example output: ... ",
    fixes_flags: ["no_examples"],
    priority: 2,
  },
  {
    id: "p_ex_3",
    category: "add_examples",
    pattern_text: "Point at a past piece you want the answer to resemble.",
    preview: " Use the tone of our last blog post as a reference. ",
    fixes_flags: ["no_examples"],
    priority: 3,
  },
];
