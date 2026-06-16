import { describe, it, expect } from "vitest";
import { buildJudgePrompt, DEFAULT_JUDGE_INSTRUCTION } from "../../open-sse/services/fusion.js";

describe("buildJudgePrompt", () => {
  it("includes the user prompt and each labeled proposer answer", () => {
    const out = buildJudgePrompt({
      userPrompt: "What is 2+2?",
      proposals: [
        { model: "openai/gpt", text: "4" },
        { model: "anthropic/claude", text: "The answer is four." },
      ],
    });
    expect(out).toContain("What is 2+2?");
    expect(out).toContain("Model A (openai/gpt)");
    expect(out).toContain("4");
    expect(out).toContain("Model B (anthropic/claude)");
    expect(out).toContain("The answer is four.");
    expect(out).toContain(DEFAULT_JUDGE_INSTRUCTION.slice(0, 20));
  });

  it("uses a custom instruction when provided", () => {
    const out = buildJudgePrompt({
      userPrompt: "Hi",
      proposals: [{ model: "x/y", text: "Hello" }],
      instruction: "CUSTOM-INSTRUCTION-MARKER",
    });
    expect(out).toContain("CUSTOM-INSTRUCTION-MARKER");
    expect(out).not.toContain(DEFAULT_JUDGE_INSTRUCTION);
  });
});
