/**
 * Canonical deficiency flags. Names are stable identifiers shared by the
 * scoring engine, the suggestion engine (server-side pattern lookup) and the
 * dashboards — do not rename without migrating all three.
 */
export const FLAGS = {
  missing_role: {
    label: "Missing role",
    description: "No expert role or persona is defined for the AI.",
    fixHint: 'Start with "Act as a [role]."',
  },
  missing_output_format: {
    label: "Missing output format",
    description: "The prompt does not specify how the answer should be structured.",
    fixHint: 'Specify a format, e.g. "Respond as a bulleted list in JSON."',
  },
  vague_context: {
    label: "Vague context",
    description: "Little background, audience or goal is provided.",
    fixHint: "Add who it is for, why, and what you already know.",
  },
  low_specificity: {
    label: "Low specificity",
    description: "The prompt is generic or contains vague words.",
    fixHint: "Add concrete details, numbers and specifics.",
  },
  no_examples: {
    label: "No examples",
    description: "No example inputs or outputs are provided.",
    fixHint: 'Add "For example: ..." to anchor the expected style.',
  },
  missing_context: {
    label: "Missing context",
    description: "Almost no context is provided.",
    fixHint: "Describe the situation, audience and goal.",
  },
  too_short: {
    label: "Too short",
    description: "The prompt is too brief to score reliably.",
    fixHint: "Add more detail about the task.",
  },
  too_long: {
    label: "Too long",
    description: "Prompt exceeds the token limit; scoring used the first 1000 characters.",
    fixHint: "Consider splitting the prompt into smaller requests.",
  },
} as const;

export type FlagName = keyof typeof FLAGS;

export type FlagInfo = {
  label: string;
  description: string;
  fixHint: string;
};

export function flagInfo(name: string): FlagInfo | undefined {
  return FLAGS[name as FlagName];
}
