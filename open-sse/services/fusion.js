/**
 * Fusion combo: query multiple proposer models in parallel, then synthesize
 * one answer with a judge model. Pure helpers here are unit-tested; the
 * orchestrator handleFusionChat (added later) wires them to the request path.
 */

export const DEFAULT_JUDGE_INSTRUCTION =
  "You are a synthesis judge. Below is a user prompt and several independent " +
  "answers from different AI models. Identify where the answers agree, where " +
  "they conflict, and any unique insight or blind spot. Then write ONE final, " +
  "authoritative answer for the user. Do not mention that multiple models were " +
  "used unless it materially helps. Resolve conflicts on the merits.";

function labelFor(index) {
  return String.fromCharCode(65 + index); // 0 -> A, 1 -> B, ...
}

/**
 * @param {{ userPrompt: string, proposals: {model:string,text:string}[], instruction?: string }} args
 * @returns {string}
 */
export function buildJudgePrompt({ userPrompt, proposals, instruction }) {
  const head = instruction || DEFAULT_JUDGE_INSTRUCTION;
  const blocks = proposals
    .map((p, i) => `### Model ${labelFor(i)} (${p.model})\n${p.text}`)
    .join("\n\n");
  return `${head}\n\n## User prompt\n${userPrompt}\n\n## Candidate answers\n${blocks}\n\n## Your synthesized answer`;
}

/**
 * Pull assistant text from a non-streaming response body in either
 * OpenAI chat-completions shape or Claude messages shape.
 * @param {any} body
 * @returns {string}
 */
export function extractAssistantText(body) {
  if (!body || typeof body !== "object") return "";
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  const msgContent = choice?.message?.content;
  if (typeof msgContent === "string") return msgContent;
  if (Array.isArray(msgContent)) {
    return msgContent.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  if (Array.isArray(body.content)) {
    return body.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("");
  }
  return "";
}

/**
 * @param {{model:string, ok:boolean, latencyMs?:number, costUsd?:number}[]} entries
 */
export function aggregateUsage(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let totalLatencyMs = 0;
  let totalCostUsd = 0;
  let okCount = 0;
  let failCount = 0;
  for (const e of list) {
    totalLatencyMs += Number(e.latencyMs) || 0;
    totalCostUsd += Number(e.costUsd) || 0;
    if (e.ok) okCount += 1; else failCount += 1;
  }
  return { totalLatencyMs, totalCostUsd, okCount, failCount, perModel: list };
}

/**
 * @param {{ok:boolean, model?:string, text?:string}[]} results
 * @returns {{path:"all_failed"}|{path:"single_passthrough",winner:object}|{path:"synthesize",survivors:object[]}}
 */
export function decideFusionOutcome(results) {
  const survivors = (Array.isArray(results) ? results : []).filter((r) => r && r.ok);
  if (survivors.length === 0) return { path: "all_failed" };
  if (survivors.length === 1) return { path: "single_passthrough", winner: survivors[0] };
  return { path: "synthesize", survivors };
}
