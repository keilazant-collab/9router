/**
 * Fusion combo: query multiple proposer models in parallel, then synthesize
 * one answer with a judge model. Pure helpers here are unit-tested; the
 * orchestrator handleFusionChat (added later) wires them to the request path.
 */

import { errorResponse } from "../utils/error.js";

export const DEFAULT_JUDGE_INSTRUCTION =
  "You are a synthesis judge. Below is a user prompt and several independent " +
  "answers from different AI models. Silently compare them - weigh where they " +
  "agree, conflict, or add unique insight - and resolve conflicts on the merits. " +
  "Then output ONLY the single best final answer to the user's prompt, written " +
  "directly as if it were your own. Do NOT include any preamble, analysis, or " +
  "commentary about the candidate answers; do NOT mention models, candidates, " +
  "agreement, or conflict; do NOT prepend labels like 'Final Answer'. Obey any " +
  "format, length, or style constraints in the user's prompt exactly. If the " +
  "prompt sets a measurable requirement (an exact word, line, or character " +
  "count, or a specific structure), count and verify it yourself and fix the " +
  "answer if it is off before you respond.";

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

export function formatProvenanceFooter({ perModel, judgeModel, degraded, judgeSkipped }) {
  const okCount = perModel.filter((m) => m.ok).length;
  const failCount = perModel.length - okCount;
  const confidence = deriveConfidence({ okCount, failCount });
  const lines = perModel.map((m) => `- ${m.model}: ${m.ok ? "ok" : "failed"}`);
  const status = degraded ? " (degraded - some proposers failed)" : "";
  const judgePart = judgeSkipped ? "judge skipped (consensus)" : `judge ${judgeModel}`;
  return [
    "",
    "---",
    `Fusion: ${okCount}/${perModel.length} models, ${judgePart}, confidence ${confidence}${status}`,
    ...lines,
  ].join("\n");
}

/**
 * Normalize a short answer for consensus comparison: drop code fences, markdown
 * emphasis, surrounding quotes/brackets and trailing punctuation, collapse
 * whitespace, lowercase. Two crisp answers like "$0.05" and "**$0.05**" compare
 * equal; anything with prose stays distinct.
 * @param {string} text
 * @returns {string}
 */
export function normalizeAnswer(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'([\]]+|["')\].,!?:;]+$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Detect unanimous short-answer consensus among proposer survivors. Fires only
 * when every survivor normalizes to the SAME string and that string is short (a
 * crisp factual/numeric answer) - in that case a judge would merely echo it, so
 * synthesis adds nothing. Long, prose, or divergent answers return
 * { consensus:false } and must go through the judge (quality preserved).
 * @param {{ok:boolean,text?:string,response?:Response}[]} survivors
 * @param {{maxLen?:number}} opts
 * @returns {{consensus:false}|{consensus:true, winner:object, normalized:string}}
 */
export function detectConsensus(survivors, { maxLen = 80 } = {}) {
  const list = (Array.isArray(survivors) ? survivors : []).filter((s) => s && s.ok);
  if (list.length < 2) return { consensus: false };
  const norms = list.map((s) => normalizeAnswer(s.text));
  if (norms.some((n) => !n || n.length > maxLen)) return { consensus: false };
  if (!norms.every((n) => n === norms[0])) return { consensus: false };
  // Representative: longest raw text among the agreeing answers (keeps units/formatting).
  const winner = list.reduce((a, b) => ((b.text || "").length > (a.text || "").length ? b : a));
  return { consensus: true, winner, normalized: norms[0] };
}

/**
 * Resolve `promise`, but if it takes longer than `ms`, resolve to `timeoutValue`
 * instead. The underlying work is abandoned (not awaited), so one hung proposer
 * cannot stall the whole fan-out. ms<=0 disables the timeout.
 */
export function withTimeout(promise, ms, timeoutValue) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(timeoutValue), ms); });
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; },
    ),
    timeout,
  ]);
}

/**
 * Settle proposer results with a "first-success grace" policy. A proposer is
 * NEVER cut until at least one has SUCCEEDED, so a slow-but-working fan-out
 * cannot fail just because every model was slow (the naive per-proposer wall
 * clock could drop them all and force a 503). Once the first ok result lands,
 * still-pending proposers get `graceMs` to finish before being cut to
 * onTimeout(i). graceMs<=0 just waits for every proposer to settle.
 * @param {Promise<any>[]} promises - resolve-only proposer promises (never reject)
 * @param {{graceMs?:number, isOk?:(r:any)=>boolean, onTimeout:(i:number)=>any}} opts
 * @returns {Promise<any[]>}
 */
export function settleProposers(promises, { graceMs = 0, isOk = (r) => r && r.ok, onTimeout } = {}) {
  const list = Array.isArray(promises) ? promises : [];
  return new Promise((resolve) => {
    if (list.length === 0) return resolve([]);
    const results = new Array(list.length);
    let remaining = list.length;
    let graceTimer = null;
    const cutPending = () => {
      for (let i = 0; i < list.length; i++) {
        if (results[i] === undefined) results[i] = onTimeout ? onTimeout(i) : { ok: false, timedOut: true };
      }
      resolve(results);
    };
    list.forEach((p, i) => {
      Promise.resolve(p).then((r) => {
        if (results[i] !== undefined) return; // already cut by grace
        results[i] = r;
        remaining -= 1;
        if (graceMs > 0 && !graceTimer && isOk(r)) graceTimer = setTimeout(cutPending, graceMs);
        if (remaining === 0) { if (graceTimer) clearTimeout(graceTimer); resolve(results); }
      });
    });
  });
}

/**
 * Detect an explicit count constraint in the user prompt (words/sentences/lines,
 * exact / max / min). Returns null when none is found. Conservative on purpose -
 * only fires on clear phrasings so it never triggers a needless repair pass.
 * @returns {{type:"words"|"sentences"|"lines", n:number, mode:"exact"|"max"|"min"}|null}
 */
export function parseCountConstraint(prompt) {
  const p = String(prompt || "");
  const units = "(words?|sentences?|lines?)";
  const norm = (u) => (/^w/.test(u) ? "words" : /^s/.test(u) ? "sentences" : "lines");
  let m;
  // max / min phrasings first, so a generic "N words" match can't shadow them.
  if ((m = p.match(new RegExp(`(?:under|at most|no more than|fewer than|less than|within)\\s+(\\d+)\\s+${units}`, "i")))) return { type: norm(m[2]), n: +m[1], mode: "max" };
  if ((m = p.match(new RegExp(`(?:at least|no fewer than|minimum of)\\s+(\\d+)\\s+${units}`, "i")))) return { type: norm(m[2]), n: +m[1], mode: "min" };
  if ((m = p.match(new RegExp(`(?:in\\s+)?exactly\\s+(\\d+)\\s+${units}`, "i")))) return { type: norm(m[2]), n: +m[1], mode: "exact" };
  if ((m = p.match(new RegExp(`\\b(\\d+)-(words?|sentences?|lines?)\\b`, "i")))) return { type: norm(m[2]), n: +m[1], mode: "exact" };
  return null;
}

export function countUnit(text, type) {
  const t = String(text || "").trim();
  if (!t) return 0;
  if (type === "words") return t.split(/\s+/).filter(Boolean).length;
  if (type === "lines") return t.split(/\n/).filter((l) => l.trim()).length;
  // sentences: count terminal punctuation groups, fall back to 1 for a non-empty blob
  const s = t.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g);
  return s ? s.length : 1;
}

/** @returns {{ok:boolean, actual:number}} */
export function checkCountConstraint(text, constraint) {
  if (!constraint) return { ok: true, actual: 0 };
  const actual = countUnit(text, constraint.type);
  const { n, mode } = constraint;
  const ok = mode === "exact" ? actual === n : mode === "max" ? actual <= n : actual >= n;
  return { ok, actual };
}

/** Write assistant text back into a parsed judge response (OpenAI or Claude shape). */
export function setAssistantText(body, text) {
  if (body?.choices?.[0]?.message) body.choices[0].message.content = text;
  else if (Array.isArray(body?.content)) body.content = [{ type: "text", text }];
  return body;
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
  const proposerTimeoutMs = Number(config.proposerTimeoutMs) || 0;

  // Run a set of proposers in parallel (buffered, stream:false) under the
  // first-success grace policy: a straggler is dropped only AFTER one proposer
  // has answered, so a slow-but-working fan-out never collapses to a 503.
  const proposerBody = { ...body, stream: false };
  const runProposers = (modelList) =>
    settleProposers(
      modelList.map((model) => (async () => {
        const started = Date.now();
        try {
          const res = await handleSingleModel(proposerBody, model);
          const latencyMs = Date.now() - started;
          if (!res.ok) return { model, ok: false, latencyMs, status: res.status };
          const json = await res.clone().json().catch(() => null);
          return { model, ok: true, latencyMs, text: extractAssistantText(json), costUsd: 0, response: res };
        } catch (e) {
          return { model, ok: false, latencyMs: Date.now() - started, error: String(e?.message || e) };
        }
      })()),
      { graceMs: proposerTimeoutMs, onTimeout: (i) => ({ model: modelList[i], ok: false, latencyMs: proposerTimeoutMs, timedOut: true }) },
    );

  // 1. Tiered fan-out: defer the slow/deep models in `escalateModels` to a
  //    second phase. Run the fast tier first; only escalate (run the deep
  //    models) when the fast tier doesn't already agree, so easy questions
  //    never pay the deep reasoner's wall-clock.
  const escalateSet = new Set(Array.isArray(config.escalateModels) ? config.escalateModels : []);
  const deepModels = models.filter((m) => escalateSet.has(m));
  const fastModels = models.filter((m) => !escalateSet.has(m));
  let results;
  if (deepModels.length === 0 || fastModels.length === 0) {
    results = await runProposers(models); // no usable tiering -> single phase (current behavior)
  } else {
    results = await runProposers(fastModels);
    const fastSurvivors = results.filter((r) => r.ok);
    const fastConsensus = !wantStream && config.consensusFastPath !== false
      && detectConsensus(fastSurvivors, { maxLen: Number(config.consensusMaxLen) || undefined }).consensus;
    if (fastConsensus) {
      log?.info?.("FUSION", `fast-tier consensus: escalation skipped (${deepModels.join(",")} not run)`);
    } else {
      log?.info?.("FUSION", `escalating to ${deepModels.join(",")} (fast tier ${fastSurvivors.length} ok)`);
      results = results.concat(await runProposers(deepModels));
    }
  }

  const usage = aggregateUsage(results);
  const outcome = decideFusionOutcome(results);
  log?.info?.("FUSION", `proposers ${usage.okCount}/${results.length} ok, path=${outcome.path}`);

  // 2. All failed -> 503. (No meaningful retry-after for fusion, so use a plain error.)
  if (outcome.path === "all_failed") {
    return errorResponse(503, "All fusion proposers unavailable");
  }

  // 3. Exactly one survivor -> passthrough (degraded), no judge call. Reuse the
  //    answer we already buffered instead of re-calling the model; only re-call
  //    when the client wanted streaming (a buffered body can't be streamed).
  if (outcome.path === "single_passthrough") {
    if (!wantStream && outcome.winner.response) return outcome.winner.response;
    return handleSingleModel(body, outcome.winner.model);
  }

  // 3.5 Consensus fast-path: if every survivor already agrees on the same short
  //     answer, the judge would only echo it - return the agreed answer and skip
  //     the extra round-trip. Non-streaming only (a buffered proposer response
  //     can't be cleanly re-emitted as SSE); streaming keeps the judge relay.
  if (config.consensusFastPath !== false && !wantStream) {
    const consensus = detectConsensus(outcome.survivors, { maxLen: Number(config.consensusMaxLen) || undefined });
    if (consensus.consensus && consensus.winner.response) {
      log?.info?.("FUSION", `consensus fast-path: judge skipped ("${consensus.normalized.slice(0, 40)}")`);
      if (!config.showProvenanceFooter) return consensus.winner.response;
      const cjson = await consensus.winner.response.clone().json().catch(() => null);
      const footer = formatProvenanceFooter({
        perModel: results.map((r) => ({ model: r.model, ok: r.ok })),
        judgeModel,
        degraded: usage.failCount > 0,
        judgeSkipped: true,
      });
      if (cjson?.choices?.[0]?.message && typeof cjson.choices[0].message.content === "string") {
        cjson.choices[0].message.content += footer;
      } else if (Array.isArray(cjson?.content)) {
        cjson.content.push({ type: "text", text: footer });
      }
      return new Response(JSON.stringify(cjson), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
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

  // 5. Judge failed -> fall back to a survivor's answer (reuse the buffered one
  //    rather than re-calling; re-call only for a streaming client).
  if (!judgeRes.ok) {
    log?.warn?.("FUSION", "judge failed, falling back to first survivor");
    if (!wantStream && outcome.survivors[0].response) return outcome.survivors[0].response;
    return handleSingleModel(body, outcome.survivors[0].model);
  }

  // 6. Streaming -> clean passthrough (constraint repair + footer are
  //    non-streaming only; streaming-footer injection stays a deferred item).
  if (wantStream) return judgeRes;
  const judgeJson = await judgeRes.clone().json().catch(() => null);
  if (!judgeJson) return judgeRes;
  let modified = false;

  // 7. Constraint repair: if the prompt sets an explicit word/sentence/line
  //    count and the judge missed it, re-ask the judge once with the exact
  //    miss. Counting is a known weak spot; an explicit nudge fixes most cases.
  const constraint = parseCountConstraint(userPrompt);
  if (constraint) {
    const text = extractAssistantText(judgeJson);
    const check = checkCountConstraint(text, constraint);
    if (!check.ok) {
      const want = constraint.mode === "exact" ? `exactly ${constraint.n}` : constraint.mode === "max" ? `at most ${constraint.n}` : `at least ${constraint.n}`;
      const fixInstruction =
        `The answer below has ${check.actual} ${constraint.type}, but the user requires ${want} ${constraint.type}. ` +
        `Rewrite it to meet that requirement EXACTLY, preserving meaning and quality. Count carefully before responding. ` +
        `Output ONLY the revised answer.\n\nAnswer:\n${text}`;
      const fixRes = await handleSingleModel({ ...judgeBody, stream: false, messages: [{ role: "user", content: fixInstruction }] }, judgeModel);
      if (fixRes.ok) {
        const fixedText = extractAssistantText(await fixRes.clone().json().catch(() => null));
        const recheck = checkCountConstraint(fixedText, constraint);
        if (fixedText && (recheck.ok || Math.abs(recheck.actual - constraint.n) < Math.abs(check.actual - constraint.n))) {
          setAssistantText(judgeJson, fixedText);
          modified = true;
          log?.info?.("FUSION", `constraint repair: ${constraint.type} ${check.actual}->${recheck.actual} (want ${want})`);
        }
      }
    }
  }

  // 8. Provenance footer (optional).
  if (config.showProvenanceFooter) {
    const footer = formatProvenanceFooter({
      perModel: results.map((r) => ({ model: r.model, ok: r.ok })),
      judgeModel,
      degraded: usage.failCount > 0,
    });
    setAssistantText(judgeJson, extractAssistantText(judgeJson) + footer);
    modified = true;
  }

  if (!modified) return judgeRes;
  return new Response(JSON.stringify(judgeJson), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
