import { CONTEXTS, EXAMPLES, FORMATS, ROLES, TOPICS } from "./templates.js";

/**
 * Prompt-improvement pattern (mirrors the metadata shape the Workers
 * suggestion engine reads from Vectorize matches).
 */
export interface PromptPattern {
  id: string;
  category: string;
  pattern_text: string;
  preview: string;
  fixes_flags: string[];
  priority: number;
}

const TARGET_COUNT = 5000;

/**
 * Deterministic generation of ~5,000 patterns from curated vocabulary
 * (spec §5.3: ~5,000 prompt-pattern templates seeded into Vectorize).
 * Order is stable across runs so seeding is reproducible.
 */
export function generatePatterns(target = TARGET_COUNT): PromptPattern[] {
  const patterns: PromptPattern[] = [];

  const push = (
    category: string,
    fixesFlags: string[],
    patternText: string,
    preview: string,
    priority: number,
  ) => {
    patterns.push({
      id: `pattern_${String(patterns.length + 1).padStart(5, "0")}`,
      category,
      pattern_text: patternText,
      preview,
      fixes_flags: fixesFlags,
      priority,
    });
  };

  // --- single-deficiency patterns -----------------------------------------
  for (const role of ROLES) {
    push(
      "add_role",
      ["missing_role"],
      `Give the AI a defined expert role before the task: "${role}".`,
      `Act as ${role}. `,
      1,
    );
  }
  for (const role of ROLES) {
    push(
      "add_role",
      ["missing_role"],
      `Frame the AI as a specialist with clear responsibilities: "${role}".`,
      `You are ${role}. `,
      2,
    );
  }
  for (const format of FORMATS) {
    push(
      "add_output_format",
      ["missing_output_format"],
      `Specify the response structure explicitly: "${format}".`,
      ` Respond as ${format}.`,
      1,
    );
  }
  for (const format of FORMATS) {
    push(
      "add_output_format",
      ["missing_output_format"],
      `Ask for a concrete output format: "${format}".`,
      ` Format the answer as ${format}.`,
      2,
    );
  }
  for (const context of CONTEXTS) {
    push(
      "add_context",
      ["vague_context", "missing_context"],
      `Add background so the AI understands the situation: "${context}".`,
      ` For context: ${context}.`,
      1,
    );
  }
  for (const context of CONTEXTS) {
    push(
      "add_context",
      ["vague_context", "missing_context"],
      `State the goal and audience so the answer fits its purpose: "${context}".`,
      ` This is for our team and ${context}.`,
      2,
    );
  }
  for (const topic of TOPICS) {
    push(
      "improve_specificity",
      ["low_specificity"],
      `Replace vague words with concrete details about "${topic}".`,
      ` Be specific: focus on ${topic} and include concrete details.`,
      1,
    );
  }
  for (const topic of TOPICS) {
    push(
      "improve_specificity",
      ["low_specificity"],
      `Add constraints like length, tone, and must-haves around "${topic}".`,
      ` Focus specifically on ${topic} with real numbers and specifics. `,
      2,
    );
  }
  for (const example of EXAMPLES) {
    push(
      "add_examples",
      ["no_examples"],
      `Add an example so the AI matches the expected style: "${example}".`,
      ` For example: use ${example} as a reference. `,
      1,
    );
  }

  // --- multi-deficiency patterns (volume driver) --------------------------
  for (const role of ROLES) {
    for (const format of FORMATS) {
      push(
        "role_and_format",
        ["missing_role", "missing_output_format"],
        `Give the AI a role and a format: "${role}", respond as "${format}".`,
        `Act as ${role} and respond as ${format}. `,
        3,
      );
    }
  }
  for (const role of ROLES) {
    for (const context of CONTEXTS) {
      push(
        "role_and_context",
        ["missing_role", "vague_context"],
        `Anchor the AI with a role and background: "${role}", and "${context}".`,
        `Act as ${role}. For context: ${context}. `,
        3,
      );
    }
  }
  for (const format of FORMATS) {
    for (const context of CONTEXTS) {
      push(
        "format_and_context",
        ["missing_output_format", "vague_context"],
        `Ask for a specific format with context: "${format}", given "${context}".`,
        ` Respond as ${format}. For context: ${context}.`,
        3,
      );
    }
  }

  // Triple-combination tier: role + format + context (volume driver to reach
  // the 5,000 target after deduplication).
  for (const role of ROLES) {
    for (const format of FORMATS) {
      for (const context of CONTEXTS) {
        push(
          "full_fix",
          ["missing_role", "missing_output_format", "vague_context"],
          `Give the AI a role, a format and context: "${role}", respond as "${format}", given "${context}".`,
          `Act as ${role} and respond as ${format}. For context: ${context}. `,
          4,
        );
      }
    }
  }

  // Deduplicate on the inserted preview text, keep deterministic order.
  const seen = new Set<string>();
  const unique = patterns.filter((p) => {
    if (seen.has(p.preview)) return false;
    seen.add(p.preview);
    return true;
  });

  return unique
    .slice(0, target)
    .map((p, index) => ({ ...p, id: `pattern_${String(index + 1).padStart(5, "0")}` }));
}
