/**
 * Starter prompts (PMF review: the sidebar's empty state offered no value —
 * "Start typing to get coaching." on a blank panel). Non-technical users
 * often do not know what to ask; one click fills the composer with a strong,
 * task-shaped prompt that they then personalize.
 *
 * Hygiene rules (same standard as suggestion previews): no placeholders
 * ("[topic]") and no invented facts ("our summer launch") — the prompts are
 * neutral and personalization is left to the user.
 */
export interface StarterPrompt {
  id: string;
  /** Short chip label shown in the sidebar. */
  label: string;
  /** The exact text inserted into the LLM composer. */
  prompt: string;
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: "email",
    label: "Write an email",
    prompt:
      "Write a professional email to a client. State the main point in the first paragraph, keep the tone friendly and clear, and end with a clear next step.",
  },
  {
    id: "summarize",
    label: "Summarize",
    prompt:
      "Summarize the key points of this text. Use 5 bullet points, then add a one-line main takeaway and any action items.",
  },
  {
    id: "brainstorm",
    label: "Brainstorm",
    prompt:
      "Brainstorm 10 practical ideas for this topic, then mark the 3 easiest to try this week and say why they are quick wins.",
  },
  {
    id: "explain",
    label: "Explain simply",
    prompt:
      "Explain this topic to a beginner. Use one simple analogy, avoid jargon, and keep the answer under 200 words.",
  },
];
