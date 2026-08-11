import { describe, expect, it } from "vitest";
import {
  RuleScoringEngine,
  bandFor,
  classifyTask,
  createScoringEngine,
  flagInfo,
  scoreExamples,
  scoreOutputFormat,
  scoreRoleClarity,
} from "../src/index";

const engine = new RuleScoringEngine();

describe("band colours (spec: red 0-49, yellow 50-69, green 70-100)", () => {
  it("maps boundaries correctly", () => {
    expect(bandFor(0)).toBe("red");
    expect(bandFor(49)).toBe("red");
    expect(bandFor(50)).toBe("yellow");
    expect(bandFor(69)).toBe("yellow");
    expect(bandFor(70)).toBe("green");
    expect(bandFor(100)).toBe("green");
  });
});

describe("vague prompt", () => {
  const result = engine.scoreSync("Help me write something good.");

  it("scores in the red band", () => {
    expect(result.score).toBeLessThan(50);
    expect(bandFor(result.score)).toBe("red");
  });

  it("flags the expected deficiencies", () => {
    expect(result.flags).toEqual(
      expect.arrayContaining([
        "low_specificity",
        "vague_context",
        "missing_role",
        "missing_output_format",
        "no_examples",
      ]),
    );
  });

  it("has a full 5-dimension breakdown in the spec shape", () => {
    expect(result.breakdown).toMatchObject({
      specificity: expect.any(Number),
      context: expect.any(Number),
      role_clarity: expect.any(Number),
      output_format: expect.any(Number),
      examples_included: expect.any(Number),
    });
    for (const v of Object.values(result.breakdown)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe("role-rich, well-specified prompt (spec §5.3 example shape)", () => {
  const prompt =
    "Act as a B2B marketing strategist. Write a LinkedIn post for our SaaS product targeting CTOs of support teams, " +
    "in 150 words with 3 bullet points and a short title. We sell analytics for customer support teams and currently " +
    "have 400 customers. For example: here is our product page https://revealyst.com. Output JSON with fields title, body, bullets.";

  const result = engine.scoreSync(prompt);

  it("scores in the green band", () => {
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(bandFor(result.score)).toBe("green");
  });

  it("gives full marks for role clarity and output format", () => {
    expect(result.breakdown.role_clarity).toBe(100);
    expect(result.breakdown.output_format).toBe(100);
  });

  it("flags nothing", () => {
    expect(result.flags).toHaveLength(0);
  });
});

describe("task-aware coaching (PMF review)", () => {
  it("does not coach a complete factual question", () => {
    const r = engine.scoreSync("What is the capital of France?");
    expect(bandFor(r.score)).toBe("green");
    expect(r.flags).toHaveLength(0);
  });

  it("does not coach a short translation request", () => {
    const r = engine.scoreSync("Translate this into Spanish: the meeting is at 3pm");
    expect(bandFor(r.score)).toBe("green");
    expect(r.flags).toHaveLength(0);
  });

  it("does not coach a short summarise request", () => {
    const r = engine.scoreSync("Summarize the key points from these meeting notes.");
    expect(bandFor(r.score)).toBe("green");
    expect(r.flags).toHaveLength(0);
  });

  it("still coaches a vague generation task", () => {
    const r = engine.scoreSync("write an email to a prospect");
    expect(bandFor(r.score)).toBe("red");
    expect(r.flags).toEqual(
      expect.arrayContaining(["low_specificity", "vague_context", "missing_role", "no_examples"]),
    );
  });

  it("does not classify a short writing task as simple", () => {
    expect(classifyTask("write a blog post about our product")).toBe("generation");
    expect(classifyTask("Can you help me write a blog post?")).toBe("generation");
  });

  it("floors role/format for explanatory tasks instead of nagging", () => {
    const r = engine.scoreSync(
      "Explain the difference between a git merge and a rebase. Assume I know basic git. Give me one concrete example of when to use each, and a rule of thumb for choosing.",
    );
    expect(bandFor(r.score)).toBe("green");
    expect(r.flags).not.toContain("missing_role");
    expect(r.flags).not.toContain("missing_output_format");
  });

  it("recognises a real analysis question as knowledge (no role/format nag)", () => {
    const r = engine.scoreSync(
      "Here are our numbers for the last quarter: revenue up 12%, churn flat at 4%, CAC up 30%. What should I focus on this quarter? Assume I run a 15-person agency and my goal is profitable growth.",
    );
    expect(bandFor(r.score)).toBe("green");
    expect(r.flags).not.toContain("missing_role");
    expect(r.flags).not.toContain("missing_output_format");
  });

  it("flags keyword-stuffed filler instead of rewarding it (anti-gameability)", () => {
    const r = engine.scoreSync(
      "Act as a wizard. Respond in JSON. For example: like this. We sell X, targeting CTOs, within budget, I need to do it for my team so that it works. Also a list, please, and markdown.",
    );
    // The "example" is empty filler — it must not count toward the score.
    expect(r.flags).toContain("no_examples");
    expect(r.breakdown.examples_included).toBeLessThan(50);
  });

  it("caps keyword-stacked context (diminishing returns)", () => {
    const stuffed = engine.scoreSync(
      "Act as a wizard. Respond in JSON. For example: like this. We sell X, targeting CTOs, within budget, I need to do it for my team so that it works.",
    );
    const contextual = engine.scoreSync(
      "Act as a B2B sales rep. Write a cold email to a CTO at a 50-person SaaS company about our analytics tool. Include a specific benefit, keep it under 100 words, and end with a call to action. For example, mention how teams save 10 hours a week.",
    );
    // A genuinely contextual prompt scores at least as well as keyword soup.
    expect(contextual.score).toBeGreaterThanOrEqual(stuffed.score);
  });

  it("gives context credit for 'assume I know/run' and 'my goal is'", () => {
    expect(
      engine.scoreSync("Explain this assuming I know basic Python.").breakdown.context,
    ).toBeGreaterThanOrEqual(50);
    expect(
      engine.scoreSync("My goal is to raise prices without losing customers.").breakdown.context,
    ).toBeGreaterThanOrEqual(40);
  });
});

describe("missing output format (generation task)", () => {
  const result = engine.scoreSync("Draft a client update.");

  it("flags missing_output_format and scores output_format low", () => {
    expect(result.flags).toContain("missing_output_format");
    expect(result.breakdown.output_format).toBeLessThan(50);
  });
});

describe("role clarity heuristics", () => {
  it("detects 'act as'", () => {
    expect(scoreRoleClarity("Act as a senior copywriter and draft this.")).toBe(100);
  });
  it("detects 'you are'", () => {
    expect(scoreRoleClarity("You are a financial analyst.")).toBe(95);
  });
  it("detects 'as a' with a role but not filler phrases", () => {
    expect(scoreRoleClarity("As a content marketer, outline the plan.")).toBe(85);
    expect(scoreRoleClarity("Use this as a result of our tests.")).toBe(25);
  });
});

describe("output format heuristics", () => {
  it("recognises explicit formats", () => {
    expect(scoreOutputFormat("Respond in JSON.")).toBe(100);
    expect(scoreOutputFormat("Give me a bulleted list.")).toBe(100);
  });
  it("recognises structural hints", () => {
    expect(scoreOutputFormat("Summarise in a short email.")).toBe(80);
  });
  it("recognises length constraints", () => {
    expect(scoreOutputFormat("Answer in 200 words.")).toBe(60);
  });
});

describe("examples heuristic", () => {
  it("scores 10 with no example markers", () => {
    expect(scoreExamples("Just do the thing.")).toBe(10);
  });
  it("scores 60+ with one substantive marker", () => {
    expect(
      scoreExamples("Give feedback. For example, here is a draft of what we wrote."),
    ).toBeGreaterThanOrEqual(60);
  });
  it("ignores filler after a marker ('For example: like this.')", () => {
    expect(scoreExamples("Give feedback. For example, like this: ...")).toBe(10);
  });
  it("counts a bare 'example' mention (not just fixed phrases)", () => {
    expect(scoreExamples("Include one concrete example of a customer win.")).toBeGreaterThanOrEqual(
      60,
    );
    expect(scoreExamples("Give me an example.")).toBeGreaterThanOrEqual(60);
    expect(scoreExamples("Use the tone of our last post as a reference.")).toBe(10);
  });
  it("does not double-count 'for example' as two signals", () => {
    expect(scoreExamples("For example, like this: ...")).toBeLessThanOrEqual(80);
  });
});

describe("context heuristics", () => {
  it("recognises an audience without 'for' (to a client, to a 10-year-old)", () => {
    expect(
      engine.scoreSync("Write an email to a client.").breakdown.context,
    ).toBeGreaterThanOrEqual(50);
    expect(
      engine.scoreSync("Explain recursion to a 10-year-old.").breakdown.context,
    ).toBeGreaterThanOrEqual(50);
    expect(engine.scoreSync("Write a note to my boss.").breakdown.context).toBeGreaterThanOrEqual(
      50,
    );
  });
  it("recognises a stated purpose ('asking for')", () => {
    expect(
      engine.scoreSync("Write an email to my boss asking for a raise.").breakdown.context,
    ).toBeGreaterThanOrEqual(50);
  });
  it("recognises hard constraints (budget, 'for 5 days')", () => {
    expect(
      engine.scoreSync("Give me a meal plan for 5 days. Budget 60 euros.").breakdown.context,
    ).toBeGreaterThanOrEqual(35);
  });
});

describe("implicit teacher role", () => {
  it("gives role credit for 'explain to a 10-year-old / beginner'", () => {
    expect(scoreRoleClarity("Explain recursion to a 10-year-old.")).toBe(70);
    expect(scoreRoleClarity("Explain this to a beginner.")).toBe(70);
  });
});

describe("output format: requested style", () => {
  it("treats an analogy/metaphor request as an output constraint", () => {
    expect(scoreOutputFormat("Use a simple analogy.")).toBeGreaterThanOrEqual(50);
  });
});

describe("realistic prompt quality (PMF regression set)", () => {
  it("scores an excellent audience+example prompt above the red band", () => {
    const r = engine.scoreSync(
      "Explain recursion to a 10-year-old. For example, like the way Russian nesting dolls work. Use a simple analogy.",
    );
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.breakdown.examples_included).toBeGreaterThanOrEqual(50);
  });
  it("recognises a concrete example inside an otherwise good prompt", () => {
    const r = engine.scoreSync(
      "Act as a B2B SaaS marketing manager. Write a 150-word cold email to a CTO who visited our pricing page. We are Acme, a 40-person company. Use a friendly tone and include one concrete example of a customer win.",
    );
    expect(r.flags).not.toContain("no_examples");
  });
});

describe("long prompt truncation (spec §7: >4000 tokens → score first 1000 chars)", () => {
  const longPrompt = "Describe our product roadmap. " + "a".repeat(17000);
  const result = engine.scoreSync(longPrompt);

  it("marks the prompt as truncated and flags too_long", () => {
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.estimatedTokens).toBeGreaterThan(4000);
    expect(result.flags).toContain("too_long");
  });
});

describe("too short prompt", () => {
  it("flags too_short", () => {
    expect(engine.scoreSync("hi").flags).toContain("too_short");
  });
});

describe("determinism", () => {
  it("produces identical results for identical input", () => {
    const prompt = "Help me write something good.";
    expect(engine.scoreSync(prompt)).toEqual(engine.scoreSync(prompt));
  });
});

describe("flag metadata", () => {
  it("exposes fix hints for every canonical flag", () => {
    expect(flagInfo("missing_role")?.fixHint).toContain("Act as");
    expect(flagInfo("missing_output_format")?.fixHint).toContain("format");
    expect(flagInfo("unknown_flag")).toBeUndefined();
  });
});

describe("factory", () => {
  it("creates a rule engine by default", () => {
    const e = createScoringEngine();
    expect(e.engineKind).toBe("rules");
  });

  it("creates an ONNX adapter when a model config is given (falls back to rules)", async () => {
    // @xenova/transformers is now a real dependency, so the adapter's dynamic
    // import would attempt an actual model download from the network. Inject a
    // failing pipelineFactory to keep the test hermetic: it is the deterministic
    // stand-in for "model cannot be loaded".
    const e = createScoringEngine({
      modelId: "revealyst/prompt-scorer-v1",
      pipelineFactory: async () => {
        throw new Error("transformers.js unavailable");
      },
    });
    expect(e.engineKind).toBe("onnx");
    const result = await e.score("Help me write something good.");
    expect(result.meta.engine).toBe("rules");
    // engineKind reflects the effective engine after the fallback (spec §7:
    // consumers use it to surface a "model unavailable" notice).
    expect(e.engineKind).toBe("rules");
  });
});
