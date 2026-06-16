import { describe, it, expect } from "vitest";
import { aggregateUsage } from "../../open-sse/services/fusion.js";

describe("aggregateUsage", () => {
  it("sums latency and cost across per-model entries", () => {
    const out = aggregateUsage([
      { model: "a/b", ok: true, latencyMs: 100, costUsd: 0.01 },
      { model: "c/d", ok: true, latencyMs: 250, costUsd: 0.02 },
      { model: "e/f", ok: false, latencyMs: 50, costUsd: 0 },
    ]);
    expect(out.totalLatencyMs).toBe(400);
    expect(out.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(out.okCount).toBe(2);
    expect(out.failCount).toBe(1);
  });

  it("handles missing numeric fields as zero", () => {
    const out = aggregateUsage([{ model: "a/b", ok: true }]);
    expect(out.totalLatencyMs).toBe(0);
    expect(out.totalCostUsd).toBe(0);
    expect(out.okCount).toBe(1);
  });
});
