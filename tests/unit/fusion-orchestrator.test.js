import { describe, it, expect } from "vitest";
import { handleFusionChat } from "../../open-sse/services/fusion.js";

const noopLog = { info() {}, warn() {}, error() {} };

function okResp(text) {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
function failResp() {
  return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
}

// Fake handleSingleModel: returns a response per model name, records calls.
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

const baseBody = { stream: false, messages: [{ role: "user", content: "Name three primary colors." }] };

describe("handleFusionChat", () => {
  it("returns 503 when all proposers fail", async () => {
    const handle = makeHandler({ "a/b": failResp(), "c/d": failResp() });
    const res = await handleFusionChat({
      body: baseBody, models: ["a/b", "c/d"], config: { judgeModel: "judge/m" },
      handleSingleModel: handle, log: noopLog,
    });
    expect(res.status).toBe(503);
  });

  it("passes through the single survivor without calling the judge", async () => {
    const handle = makeHandler({ "a/b": () => okResp("ONLY"), "c/d": failResp(), "judge/m": okResp("SHOULD-NOT-BE-USED") });
    const res = await handleFusionChat({
      body: baseBody, models: ["a/b", "c/d"], config: { judgeModel: "judge/m" },
      handleSingleModel: handle, log: noopLog,
    });
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toBe("ONLY");
    // judge/m must never have been called
    expect(handle.calls.some((c) => c.model === "judge/m")).toBe(false);
    // the final (passthrough) call uses the ORIGINAL messages, not a judge prompt
    const last = handle.calls[handle.calls.length - 1];
    expect(last.model).toBe("a/b");
    expect(last.body.messages[0].content).toBe("Name three primary colors.");
  });

  it("synthesizes via the judge when 2+ proposers succeed", async () => {
    const handle = makeHandler({ "a/b": okResp("red,green,blue"), "c/d": okResp("RGB"), "judge/m": okResp("SYNTHESIZED") });
    const res = await handleFusionChat({
      body: baseBody, models: ["a/b", "c/d"], config: { judgeModel: "judge/m" },
      handleSingleModel: handle, log: noopLog,
    });
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toBe("SYNTHESIZED");
    const judgeCall = handle.calls.find((c) => c.model === "judge/m");
    expect(judgeCall).toBeTruthy();
    // judge prompt carries the synthesis instruction + candidate answers
    expect(judgeCall.body.messages[0].content).toContain("synthesis judge");
    expect(judgeCall.body.messages[0].content).toContain("red,green,blue");
  });

  it("appends a provenance footer when enabled (non-streaming)", async () => {
    const handle = makeHandler({ "a/b": okResp("x"), "c/d": okResp("y"), "judge/m": okResp("SYNTHESIZED") });
    const res = await handleFusionChat({
      body: baseBody, models: ["a/b", "c/d"], config: { judgeModel: "judge/m", showProvenanceFooter: true },
      handleSingleModel: handle, log: noopLog,
    });
    const json = await res.clone().json();
    expect(json.choices[0].message.content).toContain("SYNTHESIZED");
    expect(json.choices[0].message.content).toContain("Fusion:");
  });
});
