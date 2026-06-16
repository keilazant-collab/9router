/**
 * Fusion combo: query multiple proposer models in parallel, then synthesize
 * one answer with a judge model. Pure helpers here are unit-tested; the
 * orchestrator handleFusionChat (added later) wires them to the request path.
 */

import { errorResponse } from "../utils/error.js";

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

/**
 * Coarse, honest confidence: all proposers succeeded -> "high";
 * some failed but >=2 succeeded -> "medium"; single answer -> "low".
 */
export function deriveConfidence({ okCount, failCount }) {
  if (okCount >= 2 && failCount === 0) return "high";
  if (okCount >= 2) return "medium";
  return "low";
}

export function formatProvenanceFooter({ perModel, judgeModel, degraded }) {
  const okCount = perModel.filter((m) => m.ok).length;
  const failCount = perModel.length - okCount;
  const confidence = deriveConfidence({ okCount, failCount });
  const lines = perModel.map((m) => `- ${m.model}: ${m.ok ? "ok" : "failed"}`);
  const status = degraded ? " (degraded - some proposers failed)" : "";
  return [
    "",
    "---",
    `Fusion: ${okCount}/${perModel.length} models, judge ${judgeModel}, confidence ${confidence}${status}`,
    ...lines,
  ].join("\n");
}

const USER_PROMPT_FALLBACK = "(see conversation)";

// Extract the latest user text from a request body across known shapes.
function latestUserText(body) {
  const pick = (arr) => {
    if (!Array.isArray(arr)) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (!m?.role || m.role === "user") return m;
    }
    return arr[arr.length - 1];
  };
  const m = pick(body?.messages) || pick(body?.input);
  if (!m) return USER_PROMPT_FALLBACK;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((b) => (typeof b === "string" ? b : b?.text || "")).join(" ").trim() || USER_PROMPT_FALLBACK;
  }
  return USER_PROMPT_FALLBACK;
}

/**
 * @param {object} args
 * @param {object} args.body - original request body (client format)
 * @param {string[]} args.models - proposer models
 * @param {object} args.config - fusion config { judgeModel?, judgePrompt?, showProvenanceFooter? }
 * @param {(body:object, model:string)=>Promise<Response>} args.handleSingleModel
 * @param {object} args.log
 */
export async function handleFusionChat({ body, models, config = {}, handleSingleModel, log }) {
  const wantStream = body?.stream === true;
  const judgeModel = config.judgeModel || models[0];

  // 1. Run proposers in parallel, buffered (stream:false).
  const proposerBody = { ...body, stream: false };
  const settled = await Promise.allSettled(
    models.map(async (model) => {
      const started = Date.now();
      const res = await handleSingleModel(proposerBody, model);
      const latencyMs = Date.now() - started;
      if (!res.ok) return { model, ok: false, latencyMs, status: res.status };
      const json = await res.clone().json().catch(() => null);
      return { model, ok: true, latencyMs, text: extractAssistantText(json), costUsd: 0 };
    })
  );
  const results = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { model: models[i], ok: false, latencyMs: 0 }
  );

  const usage = aggregateUsage(results);
  const outcome = decideFusionOutcome(results);
  log?.info?.("FUSION", `proposers ${usage.okCount}/${models.length} ok, path=${outcome.path}`);

  // 2. All failed -> 503. (No meaningful retry-after for fusion, so use a plain error.)
  if (outcome.path === "all_failed") {
    return errorResponse(503, "All fusion proposers unavailable");
  }

  // 3. Exactly one survivor -> passthrough (degraded), no judge call.
  if (outcome.path === "single_passthrough") {
    return handleSingleModel(body, outcome.winner.model);
  }

  // 4. Synthesize: build judge prompt, call judge with the client's stream pref.
  const userPrompt = latestUserText(body);
  const judgePrompt = buildJudgePrompt({
    userPrompt,
    proposals: outcome.survivors.map((s) => ({ model: s.model, text: s.text })),
    instruction: config.judgePrompt,
  });
  // Normalize the judge turn to a single `messages` entry. Null out the other
  // content carriers so a non-OpenAI/Claude inbound shape (Responses `input`,
  // Gemini `contents`) can't leak the original prompt into the judge call.
  // (Gemini-native inbound is a known v1 limitation; primary clients are
  // OpenAI/Claude format.)
  const judgeBody = {
    ...body,
    stream: wantStream,
    messages: [{ role: "user", content: judgePrompt }],
    input: undefined,
    contents: undefined,
  };
  const judgeRes = await handleSingleModel(judgeBody, judgeModel);

  // 5. Judge failed -> fall back to best survivor's answer.
  if (!judgeRes.ok) {
    log?.warn?.("FUSION", "judge failed, falling back to first survivor");
    return handleSingleModel(body, outcome.survivors[0].model);
  }

  // 6. Footer disabled -> return judge response as-is (already correct client format).
  if (!config.showProvenanceFooter) {
    return judgeRes;
  }

  // 7. Footer enabled: streaming stays a clean passthrough (streaming-footer injection
  //    is a deferred enhancement); non-streaming gets the footer appended.
  if (wantStream) {
    return judgeRes;
  }
  const judgeJson = await judgeRes.clone().json().catch(() => null);
  const footer = formatProvenanceFooter({
    perModel: results.map((r) => ({ model: r.model, ok: r.ok })),
    judgeModel,
    degraded: usage.failCount > 0,
  });
  if (judgeJson?.choices?.[0]?.message && typeof judgeJson.choices[0].message.content === "string") {
    judgeJson.choices[0].message.content += footer;
  } else if (Array.isArray(judgeJson?.content)) {
    judgeJson.content.push({ type: "text", text: footer });
  }
  return new Response(JSON.stringify(judgeJson), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
