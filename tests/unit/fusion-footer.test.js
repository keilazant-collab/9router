import { describe, it, expect } from "vitest";
import { formatProvenanceFooter } from "../../open-sse/services/fusion.js";

describe("formatProvenanceFooter", () => {
  it("lists each model with ok/fail and a coarse confidence label", () => {
    const footer = formatProvenanceFooter({
      perModel: [
        { model: "a/b", ok: true },
        { model: "c/d", ok: true },
      ],
      judgeModel: "a/b",
      degraded: false,
    });
    expect(footer).toContain("Fusion");
    expect(footer).toContain("a/b");
    expect(footer).toContain("c/d");
    expect(footer).toMatch(/confidence/i);
  });

  it("marks degraded runs", () => {
    const footer = formatProvenanceFooter({
      perModel: [{ model: "a/b", ok: true }, { model: "c/d", ok: false }],
      judgeModel: "a/b",
      degraded: true,
    });
    expect(footer).toMatch(/degraded/i);
  });
});
