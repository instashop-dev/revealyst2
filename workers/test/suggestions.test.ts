import { describe, expect, it } from "vitest";
import {
  describeDeficiency,
  getSuggestions,
  isSafeStaticPreview,
  normalizeSuggestions,
  selectStaticPatterns,
} from "../src/suggestions.js";

describe("describeDeficiency", () => {
  it("describes a single deficiency (spec §7: embedding query text)", () => {
    expect(describeDeficiency(["missing_role"])).toBe(
      "Fix a prompt that no expert role or persona is defined for the AI.",
    );
  });

  it("joins multiple deficiencies cleanly", () => {
    expect(describeDeficiency(["missing_role", "no_examples"])).toBe(
      "Fix a prompt that no expert role or persona is defined for the AI and no example inputs or outputs are provided.",
    );
  });

  it("falls back for unknown flags", () => {
    expect(describeDeficiency(["mystery_flag"])).toBe("Fix a prompt that mystery flag.");
  });

  it("returns a generic query for empty flags", () => {
    expect(describeDeficiency([])).toBe("Improve the prompt quality.");
  });
});

describe("selectStaticPatterns", () => {
  it("spreads coverage across distinct deficiencies, capped at 3", () => {
    const flags = ["missing_role", "missing_output_format", "no_examples", "vague_context"];
    const picked = selectStaticPatterns(flags);
    expect(picked.length).toBeLessThanOrEqual(3);
    const categories = new Set(picked.map((p) => p.category));
    // distinct categories preferred (role + format + examples/context)
    expect(categories.size).toBe(picked.length);
  });

  it("returns nothing when no pattern matches", () => {
    expect(selectStaticPatterns(["unknown_flag"])).toHaveLength(0);
  });

  it("orders by match count then priority", () => {
    const picked = selectStaticPatterns(["missing_output_format"]);
    expect(picked[0]?.category).toBe("add_output_format");
    expect(picked[0]?.priority).toBe(1);
  });

  it("returns no fabricated role patterns for a missing role", () => {
    // The engine never knows the task, so role coaching is advisory
    // (ROLE_SUGGESTION at the getSuggestions level), never a guessed role.
    expect(selectStaticPatterns(["missing_role"])).toHaveLength(0);
  });

  it("never inserts fabricated business facts in static context previews", () => {
    const picked = selectStaticPatterns(["vague_context"]);
    for (const p of picked) {
      expect(p.preview).not.toMatch(/\b(we|our|i) (are|have|sell|launched|want|need)\b/i);
      expect(p.preview).not.toMatch(/\[|\]|\.\.\.|…/);
    }
  });

  it("never inserts invented topics or fake examples in specificity/example previews", () => {
    // Regression: p_spec_3 used to invent a topic ("onboarding flows"),
    // p_ex_1/p_ex_3 fabricated a concrete example, p_ex_2 used "..." placeholders.
    for (const flags of [["low_specificity"], ["no_examples"]]) {
      for (const p of selectStaticPatterns(flags)) {
        expect(p.preview).not.toMatch(/onboarding|blog post|Turn every prompt/i);
        expect(p.preview).not.toMatch(/\[|\]|\{|\}|\.\.\.|…/);
        expect(p.preview).not.toMatch(/\b(we|our|i) (are|have|sell|launched|want|need)\b/i);
      }
    }
  });

  it("drops unsafe previews at the selection gate (defense in depth)", () => {
    expect(isSafeStaticPreview(" Add 2-3 sentences of background.")).toBe(true);
    expect(isSafeStaticPreview(" Example input: ... / output: ... ")).toBe(false);
    expect(isSafeStaticPreview(" Respond as a [format].")).toBe(false);
    expect(isSafeStaticPreview(" For context: our trial conversion is low.")).toBe(false);
  });
});

describe("normalizeSuggestions", () => {
  it("replaces fabricated role suggestions with the advisory suggestion", () => {
    const out = normalizeSuggestions([
      {
        id: "add_role",
        type: "add_role",
        text: "Define a role.",
        preview: "Act as an AI prompt engineer. ",
        action: "prepend",
      },
      {
        id: "add_role",
        type: "add_role",
        text: "Define a role.",
        preview: "Act as a QA specialist. ",
        action: "prepend",
      },
    ]);
    // Never a fabricated role: exactly one advisory suggestion, no preview.
    expect(out).toHaveLength(1);
    expect(out[0]?.advisory).toBe(true);
    expect(out[0]?.preview).toBe("");
    expect(out[0]?.preview).not.toMatch(/Act as/i);
  });

  it("drops non-role placeholder previews ([role], '...')", () => {
    const out = normalizeSuggestions([
      {
        id: "add_context",
        type: "add_context",
        text: "Add context.",
        preview: " For context: ...",
        action: "append",
      },
      {
        id: "add_output_format",
        type: "add_output_format",
        text: "Add a format.",
        preview: "Respond as a [format]. ",
        action: "prepend",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it("drops previews that assert invented business facts", () => {
    const out = normalizeSuggestions([
      {
        id: "add_context",
        type: "add_context",
        text: "Add context.",
        preview: " Respond as a checklist. For context: our trial conversion is low.",
        action: "append",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it("keeps the advisory role suggestion without a merged format suffix", () => {
    const out = normalizeSuggestions([
      {
        id: "add_role",
        type: "add_role",
        text: "Add a role.",
        preview: "Act as a public speaking coach and respond as an abstract.",
        action: "prepend",
      },
    ]);
    // Never fabricated — the user completes the role themselves.
    expect(out[0]?.advisory).toBe(true);
    expect(out[0]?.preview).toBe("");
    expect(out[0]?.preview).not.toMatch(/Act as|respond as/i);
  });

  it("dedupes near-identical suggestions and caps at 3", () => {
    const dup = {
      id: "add_format",
      type: "add_output_format",
      text: "Specify a format.",
      preview: " Respond as a checklist.",
      action: "append",
    };
    const out = normalizeSuggestions([
      dup,
      { ...dup, id: "add_format_2" },
      { id: "a", type: "x", text: "t1", preview: " p1.", action: "prepend" },
      { id: "b", type: "y", text: "t2", preview: " p2.", action: "prepend" },
      { id: "c", type: "z", text: "t3", preview: " p3.", action: "prepend" },
      { id: "d", type: "w", text: "t4", preview: " p4.", action: "prepend" },
    ]);
    expect(out.map((s) => s.preview)).toEqual([" Respond as a checklist.", " p1.", " p2."]);
  });

  it("keeps clean task-appropriate suggestions", () => {
    const out = normalizeSuggestions([
      {
        id: "add_role",
        type: "add_role",
        text: "Give the AI a defined expert role.",
        preview: "Act as a senior marketing strategist. ",
        action: "prepend",
      },
      {
        id: "add_context",
        type: "add_context",
        text: "Add who it is for.",
        preview:
          " Add 2-3 sentences of background: who this is for, why you need it, and what you already know.",
        action: "append",
      },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("getSuggestions end-to-end timeout (PMF review)", () => {
  it("falls back to static tips quickly when the upstream pipeline hangs", async () => {
    // The pipeline retries each OpenAI call twice with 15s timeouts, so a
    // fully degraded upstream could otherwise keep the sidebar waiting ~60s.
    // The whole chain is raced against a deadline — the static fallback must
    // arrive in milliseconds.
    const originalFetch = globalThis.fetch;
    // Never-settling fetch: the embed step hangs forever, exactly like a
    // black-holed upstream.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    try {
      const started = Date.now();
      const result = await getSuggestions(
        ["missing_output_format"],
        {
          OPENAI_API_KEY: "test-key",
          VECTORIZE: {},
        } as unknown as Parameters<typeof getSuggestions>[1],
        50,
      );
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result.source).toBe("static");
      expect(result.suggestions.length).toBeGreaterThan(0);
      // The deterministic fallback for missing_output_format kicks in.
      expect(result.suggestions[0]!.id).toBe("p_format_1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns the vectorize+llm result when the pipeline stays within budget", async () => {
    const originalFetch = globalThis.fetch;
    const embedOk = new Response(
      JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
      { status: 200 },
    );
    const suggestOk = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                suggestions: [
                  {
                    id: "add_context",
                    type: "add_context",
                    text: "Add background.",
                    preview: " Add 2-3 sentences of background: who this is for.",
                    action: "append",
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/embeddings")) return embedOk;
      if (url.includes("/chat/completions")) return suggestOk;
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const vectorize = {
      query: async () => ({
        matches: [
          {
            metadata: {
              id: "p_ctx_1",
              category: "add_context",
              pattern_text: "Add background.",
              preview: " Add 2-3 sentences of background: who this is for.",
              fixes_flags: ["vague_context"],
              priority: 1,
            },
          },
        ],
      }),
    };
    try {
      const result = await getSuggestions(
        ["vague_context"],
        {
          OPENAI_API_KEY: "test-key",
          VECTORIZE: vectorize,
        } as unknown as Parameters<typeof getSuggestions>[1],
        2000,
      );
      expect(result.source).toBe("vectorize+llm");
      // The LLM suggestion survives the deterministic guards.
      expect(result.suggestions[0]!.id).toBe("add_context");
      expect(calls.some((c) => c.includes("/embeddings"))).toBe(true);
      expect(calls.some((c) => c.includes("/chat/completions"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
