import { describe, it, expect } from "vitest";
import { decideFusionOutcome } from "../../open-sse/services/fusion.js";

describe("decideFusionOutcome", () => {
  it("returns all_failed when no proposer succeeded", () => {
    const out = decideFusionOutcome([{ ok: false }, { ok: false }]);
    expect(out.path).toBe("all_failed");
  });

  it("returns single_passthrough when exactly one succeeded", () => {
    const out = decideFusionOutcome([{ ok: true, model: "a/b", text: "x" }, { ok: false }]);
    expect(out.path).toBe("single_passthrough");
    expect(out.winner.model).toBe("a/b");
  });

  it("returns synthesize when two or more succeeded", () => {
    const out = decideFusionOutcome([
      { ok: true, model: "a/b", text: "x" },
      { ok: true, model: "c/d", text: "y" },
    ]);
    expect(out.path).toBe("synthesize");
    expect(out.survivors).toHaveLength(2);
  });
});
