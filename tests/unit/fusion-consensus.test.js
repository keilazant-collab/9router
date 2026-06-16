import { describe, it, expect } from "vitest";
import {
  normalizeAnswer,
  detectConsensus,
  withTimeout,
  handleFusionChat,
} from "../../open-sse/services/fusion.js";

const noopLog = { info() {}, warn() {}, error() {} };

function okResp(text) {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
function makeHandler(map) {
  const calls = [];
  const fn = async (body, model) => {
    calls.push({ body, model });
    const entry = map[model];
    return typeof entry === "function" ? entry(body, model) : entry;
  };
  fn.calls = calls;
  return fn;
}
const baseBody = { stream: false, messages: [{ role: "user", content: "What is 2+2?" }] };

describe("normalizeAnswer", () => {
  it("treats markdown-wrapped and trailing-punctuation variants as equal", () => {
    expect(normalizeAnswer("**$0.05**")).toBe(normalizeAnswer("$0.05"));
    expect(normalizeAnswer("Saturn.")).toBe(normalizeAnswer("saturn"));
    expect(normalizeAnswer('"Au"')).toBe("au");
  });
});

describe("detectConsensus", () => {
  it("fires when all survivors give the same short answer", () => {
    const c = detectConsensus([
      { ok: true, text: "$0.05" },
      { ok: true, text: "**$0.05**" },
      { ok: true, text: "$0.05." },
    ]);
    expect(c.consensus).toBe(true);
    expect(c.normalized).toBe("$0.05");
  });

  it("does NOT fire when answers diverge", () => {
    const c = detectConsensus([{ ok: true, text: "Paris" }, { ok: true, text: "London" }]);
    expect(c.consensus).toBe(false);
  });

  it("does NOT fire for long/prose answers even if identical", () => {
    const long = "x".repeat(200);
    const c = detectConsensus([{ ok: true, text: long }, { ok: true, text: long }]);
    expect(c.consensus).toBe(false);
  });

  it("does NOT fire with fewer than 2 survivors", () => {
    expect(detectConsensus([{ ok: true, text: "Au" }]).consensus).toBe(false);
  });
});

describe("withTimeout", () => {
  it("returns the value when it resolves in time", async () => {
    const v = await withTimeout(Promise.resolve("done"), 1000, "TIMEOUT");
    expect(v).toBe("done");
  });
  it("returns the timeout value when the promise is too slow", async () => {
    const slow = new Promise((r) => setTimeout(() => r("late"), 50));
    const v = await withTimeout(slow, 5, "TIMEOUT");
    expect(v).toBe("TIMEOUT");
  });
  it("is a passthrough when ms<=0", async () => {
    const v = await withTimeout(Promise.resolve("x"), 0, "TIMEOUT");
    expect(v).toBe("x");
  });
});

describe("handleFusionChat consensus + timeout", () => {
  it("skips the judge when proposers agree on a short answer", async () => {
    const handle = makeHandler({
      "a/b": okResp("4"),
      "c/d": okResp("**4**"),
      "judge/m": okResp("SHOULD-NOT-RUN"),
    });
    const res = await handleFusionChat({
      body: baseBody, models: ["a/b", "c/d"], config: { judgeModel: "judge/m" },
      handleSingleModel: handle, log: noopLog,
    });
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toContain("4");
    expect(handle.calls.some((c) => c.model === "judge/m")).toBe(false);
  });

  it("consensus footer notes the judge was skipped", async () => {
    const handle = makeHandler({ "a/b": okResp("Au"), "c/d": okResp("Au") });
    const res = await handleFusionChat({
      body: baseBody, models: ["a/b", "c/d"],
      config: { judgeModel: "judge/m", showProvenanceFooter: true },
      handleSingleModel: handle, log: noopLog,
    });
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toContain("judge skipped (consensus)");
  });

  it("still calls the judge when answers diverge", async () => {
    const handle = makeHandler({
      "a/b": okResp("Paris is the capital and largest city of France."),
      "c/d": okResp("The capital of France is Paris, a major world city."),
      "judge/m": okResp("SYNTHESIZED"),
    });
    const res = await handleFusionChat({
      body: baseBody, models: ["a/b", "c/d"], config: { judgeModel: "judge/m" },
      handleSingleModel: handle, log: noopLog,
    });
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toBe("SYNTHESIZED");
    expect(handle.calls.some((c) => c.model === "judge/m")).toBe(true);
  });

  it("drops a hung proposer via proposerTimeoutMs and still synthesizes", async () => {
    const handle = makeHandler({
      "fast/1": okResp("alpha answer one"),
      "slow/2": () => new Promise((r) => setTimeout(() => r(okResp("too late")), 100)),
      "fast/3": okResp("beta answer two"),
      "judge/m": okResp("SYNTHESIZED-FROM-SURVIVORS"),
    });
    const res = await handleFusionChat({
      body: baseBody, models: ["fast/1", "slow/2", "fast/3"],
      config: { judgeModel: "judge/m", proposerTimeoutMs: 20 },
      handleSingleModel: handle, log: noopLog,
    });
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toBe("SYNTHESIZED-FROM-SURVIVORS");
    // judge prompt should only contain the two fast survivors
    const judgeCall = handle.calls.find((c) => c.model === "judge/m");
    expect(judgeCall.body.messages[0].content).toContain("alpha answer one");
    expect(judgeCall.body.messages[0].content).not.toContain("too late");
  });
});
