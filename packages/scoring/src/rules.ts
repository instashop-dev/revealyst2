import type { FlagName } from "./flags.js";
import type { ScoringAdapter } from "./adapter.js";
import type { ScoreBreakdown, ScoreResult, ScoreMeta, ScoringOptions } from "./types.js";
import { DIMENSIONS } from "./types.js";

/**
 * Deterministic, framework-free prompt scoring engine.
 *
 * Scores five dimensions (specificity, context, role_clarity, output_format,
 * examples_included) on 0-100 with hand-authored heuristics, derives the
 * canonical deficiency flags, and combines everything into an overall 0-100
 * score with fixed weights. Purely synchronous under the hood (fast,
 * guaranteed <200ms) — `score()` returns a Promise to match the ScoringAdapter
 * contract.
 *
 * Task awareness (PMF review): the engine first classifies the prompt as a
 * simple request, a knowledge task, or a generation task. Simple requests
 * ("What is the capital of France?", "Translate this to Spanish") are already
 * complete — missing roles/formats/examples are not deficiencies, so all
 * dimensions are floored at 70 (green). Knowledge tasks ("Explain the
 * difference between X and Y") don't need an explicit role or output format,
 * so those two dimensions are floored. Generation tasks ("write a blog post")
 * are coached on all dimensions. This stops the engine from nagging users on
 * prompts that need no coaching.
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
 *
 * Rev 4: business-genre task kind (email/memo/report no longer nag for a role
 * or examples when specific) + vague-object detection ("explain this code to
 * me" is coached instead of floored to green).
 *
 * Rev 5: trust fixes. (a) Too-short prompts (fewer than 20 chars) are never
 * classified "simple", so "What?" no longer scores a floored green 70 while
 * carrying the too_short flag — it is coached like any other thin prompt.
 * (b) "as a/an" role credit no longer fires on filler phrases like "as an
 * example" or "as an option" (previously only "as a …" phrases were
 * excluded), so "Use this as an example" stops painting the role bar green.
 *
 * Rev 6: specificity trust + context correctness. (a) Specificity is no
 * longer mostly word count: the length ladder tops out at 76 and a
 * repetition penalty strips padding ("blah blah …"), while durations and
 * quantities ("30-second", "5 minutes") count as concrete detail, so a
 * short-but-specific prompt is no longer punished and filler is no longer
 * rewarded with a green specificity bar. (b) missing_context finally fires:
 * the context score starts at 25 and only adds, so context <= 25 means the
 * prompt has no context signals at all — the flag was dead code before.
 */
export const RULES_REVISION = 6;

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

// ---------------------------------------------------------------------------
// Task classification (PMF review): what kind of request is this?
// ---------------------------------------------------------------------------

export type TaskKind = "simple" | "knowledge" | "business" | "generation";

/** Word-count cap for a "simple request" — longer prompts are coached. */
const SIMPLE_TASK_MAX_WORDS = 14;

/** Writing/content tasks where role + output format genuinely matter. */
const GENERATION_VERBS =
  /\b(write|draft|create|generate|make|build|design|compose|prepare|produce|develop|craft|formulate|invent|brainstorm|plan|outline|email|post|essay|blog|script)\b/i;

/** Short imperative tasks that are complete without a role or format. */
const SIMPLE_TASK_VERBS =
  /\b(translate|define|spell|calculate|convert|summarize|summarise|paraphrase|rephrase|proofread|correct|check|interpret|name|list|find|look up|show|explain)\b/i;

/** Direct questions ("What is …?", "How does …?") are complete as-is. */
const QUESTION_STARTERS =
  /^(what|when|where|who|whose|whom|which|why|how|is|are|do|does|did|can|could|should|would|will)\b/i;

/** Explanatory tasks don't need "Act as …" or a specified output format. */
const KNOWLEDGE_VERBS =
  /\b(explain|describe|summarize|summarise|analyze|analyse|compare|contrast|translate|calculate|convert|answer|review|interpret|define|evaluate|assess|discuss|elaborate|clarify|detail)\b/i;

/**
 * Classify a prompt so the scorer knows which dimensions to coach:
 *
 * - "simple": short question or short imperative ("What is the capital of
 *   France?", "Translate this to Spanish"). Already complete — nothing to
 *   coach.
 * - "knowledge": explanation/analysis ("Explain the difference between X and
 *   Y", a question inside a longer prompt). Role and output format are
 *   optional, not deficiencies.
 * - "business": a business-writing genre (email, memo, report, …) with a real
 *   audience or purpose — role and a worked example are optional once the
 *   request is already specific (see applyTaskFloors). Vague business requests
 *   are still coached.
 * - "generation": "write/draft/create …" — coached on all five dimensions.
 */
export function classifyTask(text: string): TaskKind {
  const trimmed = text.trim();
  const words = wordCount(trimmed);
  const head = trimmed.replace(/^please\s+/i, "").slice(0, 120);
  const hasGenerationVerb = GENERATION_VERBS.test(trimmed);
  const isShort = words <= SIMPLE_TASK_MAX_WORDS;
  // A prompt this short cannot be judged complete: "What?" is not a finished
  // request, and flooring it to a green 70 while also flagging too_short is a
  // contradiction users notice (score 70 "green" + "too short" coaching).
  // Such prompts fall through to knowledge/generation and get real coaching.
  const tooShort = trimmed.length < 20;

  if (isShort && !hasGenerationVerb && !tooShort) {
    // A short request whose object is a vague referent ("explain this code to
    // me", "summarize this") is NOT complete — the object is underspecified,
    // so it must not be floored to green. "Translate this into Spanish" is
    // complete (the target follows); "explain recursion" is complete (a real
    // object).
    if ((QUESTION_STARTERS.test(text) || /\?\s*$/.test(text)) && !VAGUE_OBJECT_RE.test(text))
      return "simple";
    if (SIMPLE_TASK_VERBS.test(head) && !VAGUE_OBJECT_RE.test(text)) return "simple";
  }
  if (KNOWLEDGE_VERBS.test(head) && !hasGenerationVerb) return "knowledge";
  if (BUSINESS_GENRES.test(text) && hasBusinessContext(text)) return "business";
  if (/\?/.test(text) && !hasGenerationVerb && words <= 80) return "knowledge";
  return "generation";
}

/**
 * Vague deictic referents that make a short request underspecified: "explain
 * this code to me", "summarize this", "review that". Tolerates trailing
 * punctuation ("Can you explain this code?") but NOT a following target
 * ("translate this into Spanish") or audience ("explain this to a beginner").
 */
const VAGUE_OBJECT_RE =
  /\b(this|that|it|these|those|one)\b(?:\s+(?:code|thing|stuff|text|document|doc|file|paragraph|line|section|part|bit))?(?:\s+(?:to|for)\s+(?:me|us))?[?!.]?\s*$/i;

/**
 * Business-writing genres where an explicit "Act as …" role and a worked
 * example are optional once the request names an audience and purpose: a
 * payment-reminder email, an internal update, a board report. Content
 * generation ("blog post", "LinkedIn post") is deliberately NOT included —
 * those tasks benefit from a role and examples.
 */
const BUSINESS_GENRES =
  /\b(?:email|memo|report|note|agenda|newsletter|update|announcement|brief|minutes|reply|reminder|letter|summary|recap|overview)\b/i;

/**
 * True when a business-genre prompt names an audience or purpose — the same
 * signal families scoreContext rewards. "Write an email to a prospect" fails
 * this (a prospect is not a concrete audience), so it keeps full coaching.
 */
function hasBusinessContext(text: string): boolean {
  if (
    /\b(for|to|with|of)\b[^.!?]{0,50}\b(team|audience|client|customer|customers|users?|readers?|boss|manager|stakeholders?|board|investors?|ceo|cto|founder|founders|leaders?|directors?|hr|sales|marketing|finance|accounting|recruiters?|suppliers?|vendors?)\b/i.test(
      text,
    )
  )
    return true;
  return /so that|my goal is|asking for|we (sell|are|build|provide)|our (company|product|service|team|client|clients)|currently|for a project|for our/i.test(
    text,
  );
}

/**
 * Floor dimensions that don't apply to the task. The displayed breakdown and
 * the derived flags both use the floored values, so a factual question never
 * shows "missing role" and an explanation never nags for an output format.
 *
 * Business tasks floor role + examples whenever the request names an audience
 * or purpose (context ≥ 55) — a business request with a real audience never
 * needs "Act as …" or a worked example. Specificity and output-format coaching
 * still apply, so a vague "write an email to my boss" keeps the useful nags
 * (add specifics, pick a format) and only loses the nonsensical ones.
 */
export function applyTaskFloors(breakdown: ScoreBreakdown, kind: TaskKind): ScoreBreakdown {
  const floored = { ...breakdown };
  if (kind === "simple") {
    for (const dim of DIMENSIONS) floored[dim] = Math.max(floored[dim], 70);
  } else if (kind === "knowledge") {
    floored.role_clarity = Math.max(floored.role_clarity, 70);
    floored.output_format = Math.max(floored.output_format, 70);
  } else if (kind === "business") {
    if (breakdown.context >= 55) {
      floored.role_clarity = Math.max(floored.role_clarity, 70);
      floored.examples_included = Math.max(floored.examples_included, 70);
    }
  }
  return floored;
}

const VAGUE_WORDS =
  /\b(thing|things|stuff|something|some|nice|good|better|great|etc\.?|basically|really|kind of|sort of|make it|do it|help me with it)\b/gi;

/** Concrete signals: numbers, durations, quantities, URLs, identifiers,
 *  proper nouns (a capitalised word mid-sentence — not the start of a
 *  sentence). Durations like "30-second" and quantities like "5 minutes" or
 *  "400 customers" are real specificity — a short prompt that names them is
 *  more specific than a long one that names nothing (PMF review). */
const CONCRETE_SIGNALS =
  /\d+%|\$\s?\d+|\d+[ -]?(seconds?|minutes?|hours?|days?|weeks?|months?|years?|words|items|examples|ideas|options|points|pages|paragraphs|people|users|questions|steps|tips|reasons|ways|bullet points|customers|clients|leads|emails|requests|tasks|projects)|https?:\/\/\S+|@\w+|(?<![.!?]\s|^)[A-Z][a-z]{3,}/g;

/**
 * Padding is not specificity: when a single word dominates a long prompt
 * ("blah blah …", lorem-style filler), the length is repetition, not detail.
 * Returns a penalty (0-25); only triggers on prompts long enough to look
 * detailed (25+ words) with one word making up >= 1/4 of them.
 */
function repetitionPenalty(text: string): number {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 25) return 0;
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  let max = 0;
  for (const f of freq.values()) if (f > max) max = f;
  if (max / words.length >= 0.25) return 25;
  return 0;
}

export function scoreSpecificity(text: string): number {
  const wc = wordCount(text);
  // Length alone is weak evidence of specificity: the ladder tops out at 76
  // so pure padding can never paint the specificity bar green — concrete
  // detail (numbers, durations, quantities, names, URLs) earns the top band.
  // (PMF review: an 80-word filler prompt previously scored specificity 92.)
  let base: number;
  if (wc < 5) base = 20;
  else if (wc < 15) base = 40;
  else if (wc < 30) base = 60;
  else if (wc < 50) base = 75;
  else base = 76;

  const repetition = repetitionPenalty(text);
  // Padding cannot claim concrete credit: when one word dominates the prompt,
  // repeated "concrete-looking" words (capitalised filler like "Blah Blah …")
  // must not resurrect the specificity score.
  const concrete = repetition > 0 ? 0 : countMatches(text, CONCRETE_SIGNALS);
  const vague = countMatches(text, VAGUE_WORDS);
  return clamp(base + concrete * 8 - vague * 6 - repetition);
}

export function scoreContext(text: string): number {
  const s = 25;
  const bonuses: number[] = [];
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
    bonuses.push(30);
  }
  // Purpose is stated: "so that", "in order to", "asking for", "to draft",
  // "give/tell/show me", "my goal is", …
  if (
    /so that|in order to|so i can|to (achieve|improve|increase|reduce|learn|understand|decide|prepare|convince|sell|explain|teach|build|design|write|create|get|ask|request|draft|plan)/i.test(
      text,
    ) ||
    /\b(asking|hoping|looking) (for|to)\b/i.test(text) ||
    /\b(give|tell|show) me\b/i.test(text) ||
    /\b(my|our|the) goal is\b/i.test(text)
  ) {
    bonuses.push(20);
  }
  if (
    /\b(background|context|we (are|sell|build|work|use|need)|our (company|product|service|team)|i (am|work)|currently|as part of|for a project|we are a)\b/i.test(
      text,
    ) ||
    // "Assume I know basic git" / "Assume I run a 15-person agency" — a
    // stated level or situation is real background.
    /\bassum(?:e|ing) (i|you|we|they) (know|understand|are|have|can|run|work|sell|build|use)\b/i.test(
      text,
    )
  ) {
    bonuses.push(25);
  }
  if (/\b(our|the) (product|service|app|tool|company|platform|dashboard)\b/i.test(text)) {
    bonuses.push(15);
  }
  // Hard constraints: budget, deadline, "for 5 days", "per week".
  if (
    /\b(within|under|no more than|at least|must|should|requirement|requirements|budget|deadline|per (day|week|month|person|user))\b/i.test(
      text,
    ) ||
    /\bfor \d+ (days?|weeks?|months?|people|hours?)\b/i.test(text)
  ) {
    bonuses.push(10);
  }
  if (/^i (need|want) to/i.test(text.trim())) {
    bonuses.push(10);
  }
  // Diminishing returns (anti-gameability): the two strongest signals count
  // in full, the rest at half, total capped at +60. Stacking every keyword no
  // longer maxes out context — a genuinely contextual prompt does not need to.
  const ordered = bonuses.sort((a, b) => b - a);
  let bonus = 0;
  ordered.forEach((b, i) => {
    bonus += i < 2 ? b : Math.round(b / 2);
  });
  bonus = Math.min(bonus, 60);
  return clamp(s + bonus);
}

const EXCLUDED_AS_PHRASES =
  /as a (result|whole|rule|way|means|team|company|part|first step|second step|start|last resort|follow-up)|as an? (example|examples|option|alternative|reference|input|output|well|though|usual|follow-up)/i;

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

/**
 * An example marker followed by nothing but filler ("For example: like this.",
 * "e.g. …") is not a real example — counting it would let keyword-stuffed
 * prompts fake the examples dimension (PMF review anti-gameability). Returns
 * the length of the filler fragment (0 when the marker is substantive).
 */
function trivialFillerLen(text: string): number {
  const m = text.match(
    /^[^a-z0-9]{0,6}(?:like this|this|that|such|etc\.?|\.\.\.|…)[^a-z0-9]{0,4}(?:[.!?:]|$)/i,
  );
  return m ? m[0].length : 0;
}

export function scoreExamples(text: string): number {
  // Count fixed example phrases first and remove them, so "for example"
  // counts once. A marker only counts when it is followed by real content
  // (at least a short clause) — "for example: like this" is filler, not an
  // example. Then a bare "example/sample" mention ("include one example",
  // "give an example") also counts as an example signal.
  let t = text;
  let n = 0;
  for (const re of EXAMPLE_MARKERS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 60);
      const filler = trivialFillerLen(after);
      if (filler === 0) n += 1;
      // Remove the marker (and any trivial filler that follows it) so later
      // markers can't double-count the same fragment.
      const removeLen = m[0].length + filler;
      t = t.slice(0, m.index) + " " + t.slice(m.index + removeLen);
      re.lastIndex = m.index;
    }
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
  // The context score starts at 25 and only ever adds bonuses, so a score of
  // exactly 25 means the prompt carries NO context signals (audience, purpose,
  // background, constraints). Previously the threshold was < 25, which the
  // rule engine could never reach — missing_context was dead code and even an
  // empty prompt did not flag it.
  if (breakdown.context <= 25) flags.push("missing_context");
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

    const kind = classifyTask(scored);
    const rawBreakdown: ScoreBreakdown = {
      specificity: scoreSpecificity(scored),
      context: scoreContext(scored),
      role_clarity: scoreRoleClarity(scored),
      output_format: scoreOutputFormat(scored),
      examples_included: scoreExamples(scored),
    };
    // Simple requests and knowledge tasks don't need coaching on every
    // dimension (see classifyTask) — floor the ones that don't apply so the
    // flags, breakdown and overall score reflect what the prompt actually
    // needs.
    const breakdown = applyTaskFloors(rawBreakdown, kind);
    // Report which dimensions were auto-satisfied so the sidebar can render
    // them as "not needed" instead of a misleading green bar (PMF review).
    const flooredDims = DIMENSIONS.filter((dim) => breakdown[dim] > rawBreakdown[dim]);

    const meta: ScoreMeta = {
      engine: "rules",
      truncated,
      estimatedTokens,
      wordCount: wc,
      charCount,
      flooredDims: flooredDims.length > 0 ? flooredDims : undefined,
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
