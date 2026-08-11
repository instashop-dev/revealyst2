import type { FlagName } from "./flags.js";
import type { ScoringAdapter } from "./adapter.js";
import type { ScoreBreakdown, ScoreResult, ScoreMeta, ScoringOptions } from "./types.js";

/**
 * Deterministic, framework-free prompt scoring engine.
 *
 * Scores five dimensions (specificity, context, role_clarity, output_format,
 * examples_included) on 0-100 with hand-authored heuristics, derives the
 * canonical deficiency flags, and combines everything into an overall 0-100
 * score with fixed weights. Purely synchronous under the hood (fast,
 * guaranteed <200ms) — `score()` returns a Promise to match the ScoringAdapter
 * contract.
 */

export const DEFAULT_MAX_TOKENS = 4000;
export const DEFAULT_TRUNCATE_TO = 1000;
const CHARS_PER_TOKEN = 4;

/**
 * Bump when the scoring heuristics change the score/flags for existing
 * prompts. The ONNX scorer (prompt-scorer-v1) is a distillation of these
 * rules: a model trained on an older revision must not override the current
 * rules (see OnnxScoringAdapter's rules_rev gate), so a stale model falls
 * back to the rule engine until it is retrained against the new revision.
 */
export const RULES_REVISION = 2;

const DIMENSION_WEIGHTS = {
  specificity: 0.25,
  context: 0.25,
  role_clarity: 0.2,
  output_format: 0.2,
  examples_included: 0.1,
} as const;

/** Rough token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, n));
}

function wordCount(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

const VAGUE_WORDS =
  /\b(thing|things|stuff|something|some|nice|good|better|great|etc\.?|basically|really|kind of|sort of|make it|do it|help me with it)\b/gi;

/** Concrete signals: numbers, quantities, URLs, identifiers, proper nouns. */
const CONCRETE_SIGNALS =
  /\d+%|\$\s?\d+|\d+\s?(words|items|examples|ideas|options|points|pages|paragraphs|people|users|days|hours|months|years)|https?:\/\/\S+|@\w+|(?<![.!?]\s)[A-Z][a-z]{3,}/g;

export function scoreSpecificity(text: string): number {
  const wc = wordCount(text);
  let base: number;
  if (wc < 5) base = 20;
  else if (wc < 15) base = 40;
  else if (wc < 30) base = 60;
  else if (wc < 50) base = 75;
  else if (wc < 80) base = 85;
  else base = 92;

  const concrete = countMatches(text, CONCRETE_SIGNALS);
  const vague = countMatches(text, VAGUE_WORDS);
  return clamp(base + concrete * 8 - vague * 6);
}

export function scoreContext(text: string): number {
  let s = 25;
  // Audience is defined: "for/to/with my team", "to a client", "targeting
  // CTOs", "aimed at non-technical small business owners", "to a 10-year-old".
  // (Previously only "for (my|our|the|a) <audience>" was recognised, so
  // prompts like "explain this to a 10-year-old" or "email to my boss" got no
  // context credit at all.)
  if (
    /\b(for|to|with) (my|our|the|a|an) (team|audience|client|customer|users?|readers?|boss|manager|stakeholders?|students?|kids?|children?|beginners?|experts?|senior|junior|company|small business owners?)\b/i.test(
      text,
    ) ||
    /\b(target(?:ing|ed)|aimed at|geared toward|intended for|written for|addressed to|for|to)\b[^.!?]{0,40}\b(ctos?|ceos?|founders?|managers?|leaders?|developers?|designers?|marketers?|salespeople?|recruiters?|parents?|businesses?|startups?|smes?|beginners?|small business owners?)\b/i.test(
      text,
    ) ||
    /\b(?:to|for) (?:a|an|my|our|the) \d{1,2}-?year-?olds?\b/i.test(text)
  ) {
    s += 30;
  }
  // Purpose is stated: "so that", "in order to", "asking for", "to draft", …
  if (
    /so that|in order to|so i can|to (achieve|improve|increase|reduce|learn|understand|decide|prepare|convince|sell|explain|teach|build|design|write|create|get|ask|request|draft|plan)/i.test(
      text,
    ) ||
    /\b(asking|hoping|looking) (for|to)\b/i.test(text)
  ) {
    s += 20;
  }
  if (
    /\b(background|context|we (are|sell|build|work|use|need)|our (company|product|service|team)|i (am|work)|currently|as part of|for a project|we are a)\b/i.test(
      text,
    )
  ) {
    s += 25;
  }
  if (/\b(our|the) (product|service|app|tool|company|platform|dashboard)\b/i.test(text)) {
    s += 15;
  }
  // Hard constraints: budget, deadline, "for 5 days", "per week".
  if (
    /\b(within|under|no more than|at least|must|should|requirement|requirements|budget|deadline|per (day|week|month|person|user))\b/i.test(
      text,
    ) ||
    /\bfor \d+ (days?|weeks?|months?|people|hours?)\b/i.test(text)
  ) {
    s += 10;
  }
  if (/^i (need|want) to/i.test(text.trim())) {
    s += 10;
  }
  return clamp(s);
}

const EXCLUDED_AS_PHRASES =
  /as a (result|whole|rule|way|means|team|company|part|first step|second step|start|last resort)/i;

export function scoreRoleClarity(text: string): number {
  if (/act as (a|an)/i.test(text)) return 100;
  if (/you are (a|an|the)/i.test(text)) return 95;
  if (/assume (the role|the persona|you)/i.test(text)) return 85;
  if (/your (role|job|task) is/i.test(text)) return 85;
  if (/imagine you are/i.test(text)) return 80;
  if (/pretend (to be|you are)/i.test(text)) return 75;
  if (/as an? /i.test(text) && !EXCLUDED_AS_PHRASES.test(text)) return 85;
  // Implicit teacher role: "explain X to a 10-year-old / a beginner" assigns
  // the AI a clear persona (spec §5.2 role clarity) without "act as".
  if (
    /explain (?:it|this|that|the|\w+) to (?:a|an|my|our|the) (?:kid|kids|child|children|beginner|beginners|\d{1,2}-?year-?old)/i.test(
      text,
    )
  ) {
    return 70;
  }
  return 25;
}

export function scoreOutputFormat(text: string): number {
  if (
    /(no (specific )?(format|structure))|(don'?t use (a )?(format|structure|list|bullets))|(just (write|tell|say))/i.test(
      text,
    )
  ) {
    return 20;
  }
  if (
    /\b(json|markdown|csv|yaml|xml|html|table|bullet points?|bulleted (list|points?)|numbered list|checklist|outline)\b/i.test(
      text,
    )
  ) {
    return 100;
  }
  if (
    /\b(list|paragraphs?|sections?|headings?|template|format|structure|steps?|summary|abstract|email|script|essay|post|thread|memo|report|faq)\b/i.test(
      text,
    )
  ) {
    return 80;
  }
  let s = 20;
  // A requested style (analogy/metaphor) is a real output constraint even
  // without a structure keyword (e.g. "Use a simple analogy.").
  if (/\b(analogy|analogies|metaphor|metaphors)\b/i.test(text)) {
    s += 40;
  }
  if (
    /in (at most|around|about|exactly|under)? ?\d+[ -]?(words|characters|pages|sentences|paragraphs|bullet points|items|ideas)/i.test(
      text,
    )
  ) {
    s += 40;
  }
  if (/with (a )?(title|heading|header)/i.test(text)) {
    s += 20;
  }
  return clamp(s);
}

const EXAMPLE_MARKERS = [
  /\bfor example\b/gi,
  /\bfor instance\b/gi,
  /\be\.g\.\b/gi,
  /\bsuch as\b/gi,
  /\blike (this|the following)\b/gi,
  /\bhere'?s an example\b/gi,
  /\bhere are\b/gi,
  /\bsample\b/gi,
  /\bexample[:：]\b/gi,
  /\binput[:：]\b/gi,
  /\boutput[:：]\b/gi,
  /\bgiven (the following|this)\b/gi,
  /\bdesired (outcome|output)[:：]\b/gi,
  /\btemplate[:：]\b/gi,
];

export function scoreExamples(text: string): number {
  // Count fixed example phrases first and remove them, so "for example"
  // counts once. Then a bare "example/sample" mention ("include one
  // example", "give an example") also counts as an example signal —
  // previously a prompt explicitly asking for an example was flagged
  // "no_examples" because only the fixed phrases were recognised.
  let t = text;
  let n = 0;
  for (const re of EXAMPLE_MARKERS) {
    n += countMatches(t, re);
    t = t.replace(re, " ");
  }
  n += countMatches(t, /\bexamples?\b/gi);
  n += countMatches(t, /\bsamples?\b/gi);
  if (n === 0) return 10;
  if (n === 1) return 60;
  if (n === 2) return 80;
  return 95;
}

/**
 * Derive canonical flags from a breakdown, using the same thresholds the rule
 * engine applies. Shared with the ONNX adapter so both paths flag identically.
 */
export function deriveFlags(
  breakdown: ScoreBreakdown,
  meta: Pick<ScoreMeta, "truncated" | "charCount">,
): FlagName[] {
  const flags: FlagName[] = [];
  if (meta.charCount < 20) flags.push("too_short");
  if (breakdown.specificity < 60) flags.push("low_specificity");
  if (breakdown.context < 55) flags.push("vague_context");
  if (breakdown.context < 25) flags.push("missing_context");
  if (breakdown.role_clarity < 50) flags.push("missing_role");
  if (breakdown.output_format < 50) flags.push("missing_output_format");
  if (breakdown.examples_included < 50) flags.push("no_examples");
  if (meta.truncated) flags.push("too_long");
  return flags;
}

export class RuleScoringEngine implements ScoringAdapter {
  readonly engineKind = "rules" as const;

  score(prompt: string, options?: ScoringOptions): Promise<ScoreResult> {
    return Promise.resolve(this.scoreSync(prompt, options));
  }

  scoreSync(prompt: string, options: ScoringOptions = {}): ScoreResult {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const truncateTo = options.truncateTo ?? DEFAULT_TRUNCATE_TO;

    const text = prompt.trim();
    const charCount = text.length;
    const estimatedTokens = estimateTokens(text);
    const truncated = estimatedTokens > maxTokens;
    const scored = truncated ? text.slice(0, truncateTo) : text;
    const wc = wordCount(scored);

    const meta: ScoreMeta = {
      engine: "rules",
      truncated,
      estimatedTokens,
      wordCount: wc,
      charCount,
    };

    const breakdown: ScoreBreakdown = {
      specificity: scoreSpecificity(scored),
      context: scoreContext(scored),
      role_clarity: scoreRoleClarity(scored),
      output_format: scoreOutputFormat(scored),
      examples_included: scoreExamples(scored),
    };

    const flags: FlagName[] = deriveFlags(breakdown, meta);

    const score = Math.round(
      breakdown.specificity * DIMENSION_WEIGHTS.specificity +
        breakdown.context * DIMENSION_WEIGHTS.context +
        breakdown.role_clarity * DIMENSION_WEIGHTS.role_clarity +
        breakdown.output_format * DIMENSION_WEIGHTS.output_format +
        breakdown.examples_included * DIMENSION_WEIGHTS.examples_included,
    );

    return { score: clamp(score), breakdown, flags, meta };
  }
}
