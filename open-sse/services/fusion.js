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
