import { describe, it, expect } from "vitest";
import { extractAssistantText } from "../../open-sse/services/fusion.js";

describe("extractAssistantText", () => {
  it("extracts OpenAI chat completion text", () => {
    const body = { choices: [{ message: { role: "assistant", content: "hello openai" } }] };
    expect(extractAssistantText(body)).toBe("hello openai");
  });

  it("extracts Claude messages text from content blocks", () => {
    const body = { content: [{ type: "text", text: "hello " }, { type: "text", text: "claude" }] };
    expect(extractAssistantText(body)).toBe("hello claude");
  });

  it("returns empty string when no text is present", () => {
    expect(extractAssistantText({})).toBe("");
    expect(extractAssistantText(null)).toBe("");
  });
});
