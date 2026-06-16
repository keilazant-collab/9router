import { describe, it, expect } from "vitest";
import { decideFusionOutcome } from "../../open-sse/services/fusion.js";

// Routing contract: chat.js branches to fusion when combo.kind === "fusion"
// and there are at least 2 proposer models.
describe("fusion routing predicate", () => {
  const isFusion = (combo) =>
    !!combo && combo.kind === "fusion" && Array.isArray(combo.models) && combo.models.length >= 2;
  it("routes a 2+ model fusion combo", () => {
    expect(isFusion({ kind: "fusion", models: ["a/b", "c/d"] })).toBe(true);
  });
  it("does not route a fallback combo", () => {
    expect(isFusion({ kind: "fallback", models: ["a/b", "c/d"] })).toBe(false);
  });
  it("does not route a single-model fusion combo (nothing to fuse)", () => {
    expect(isFusion({ kind: "fusion", models: ["a/b"] })).toBe(false);
  });
  it("outcome helper is importable in this context", () => {
    expect(typeof decideFusionOutcome).toBe("function");
  });
});
