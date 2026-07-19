/**
 * MoA prompt builders (Sprint 5 §10 — extracted from `moa.ts` to shrink
 * `runMoAEnsemble`'s host file below the §8 line). Pure string assembly with
 * ZERO closure over ensemble state, which is exactly why this is the safest,
 * lowest-risk leaf slice of the moa.ts decomposition. Re-exported from `moa.ts`
 * for back-compat with existing importers (`agent.ts`, `moa.test.ts`).
 */

// ── Aggregator Prompt ───────────────────────────────────────────────────
// PM #40 — synthesis prompt adapted from Together AI's MoA paper template
// (togethercomputer/MoA `prompts.py`), which was validated at 65.1% on
// AlpacaEval and beat GPT-4o (57.5%) using only open-source models.
//
// Key adaptations from the original:
//   - Orchestra-specific code-block preservation rule (genuinely useful
//     for the operator's primary workflows).
//   - "No meta-commentary" rule (cuts the "Based on the drafts above..."
//     preamble that bloats outputs).
//   - Cross-reference to the PM #39 disagreement marker — when present in
//     the user content, the synthesizer is reminded to follow its
//     instructions explicitly.
//
// The system role carries IDENTITY + RULES (stable across turns); the
// user content carries DATA (original request + numbered drafts). This
// is the cleaner split — previously the system was a one-liner and the
// rules were duplicated in the user content.

export const AGGREGATOR_SYSTEM_PROMPT = `You are the Aggregator at the final stage of a Mixture-of-Agents (MoA) pipeline. You have been provided with a set of responses from specialized expert agents who analyzed the user's request in parallel. Your task is to synthesize these responses into a single, high-quality reply.

It is crucial to critically evaluate the information in the expert responses, recognizing that some of it may be biased, incomplete, or incorrect. Your response should NOT simply replicate or vote-aggregate the drafts — it should offer a refined, accurate, and comprehensive reply that goes beyond any individual draft.

Strict rules:
1. PRESERVE TECHNICAL DETAIL. Specific version numbers, library names, API signatures, configuration values — keep them. Do NOT summarize them away.
2. CODE BLOCK INTEGRITY. Include all relevant code from the drafts. When drafts disagree on implementation, pick the most robust + production-ready version (or merge with explanatory comments). NEVER skip code to save space.
3. NO META-COMMENTARY. Start directly with the answer. Do NOT begin with "Based on the drafts" / "Here is the synthesis" / "Looking at the responses" / "After analyzing the experts".
4. CONFLICT RESOLUTION. If experts disagree on a factual claim (library version, API behavior, etc.), use your knowledge to pick the most accurate and modern choice. If you see a "<<DISAGREEMENT_DETECTED>>" marker in the user content, follow its additional instructions exactly — surface the conflict to the user, do not smooth it away.
5. MATCH USER'S FORMAT. Mirror the user's expected output structure (code-only, markdown with headers, JSON, plain prose) — don't add ceremony the user didn't ask for.
6. CORRECT SILENTLY. If you spot factual errors in the drafts, correct them in your synthesis without explicitly calling out the original mistake.

Adhere to the highest standards of accuracy and reliability.`;

export function buildAggregatorPrompt(userMessage: string, drafts: { role: string; text: string }[]): string {
  // Numbered format matches Together MoA's reference template — empirically
  // tuned for LLM synthesis quality. Role label stays as a hint, not a
  // hierarchy ("expert N (role: ...)") so the synthesizer doesn't infer
  // implicit priority from order.
  const draftBlock = drafts
    .map((d, i) => `${i + 1}. [Expert role: ${d.role}]\n${d.text}`)
    .join("\n\n");

  return `Original user request:
${userMessage}

Responses from expert agents (treat each as a candidate, not as authority):

${draftBlock}

Now produce the final synthesized response.`;
}

/**
 * Sprint 2 — MoA aggregator collapse (docs/moa-aggregator-collapse.md). Assemble
 * the block appended to the orchestrator system prompt on the collapsed synthesis
 * path: the ported synthesis `directive`, the optional PM #39 disagreement
 * `marker`, then the numbered expert drafts. The numbering/role-label format
 * mirrors `buildAggregatorPrompt` so the collapsed synthesizer sees the same
 * draft shape the standalone aggregator did. The drafts go in the SYSTEM prompt
 * (not a second user message) — a consecutive `user` turn crashes strict models
 * (PM #2). Pure + exported for unit testing.
 */
export function buildInlineSynthesisInjection(
  directive: string,
  drafts: { role: string; text: string }[],
  disagreementMarker: string
): string {
  const draftBlock = drafts
    .map((d, i) => `${i + 1}. [Expert role: ${d.role}]\n${d.text}`)
    .join("\n\n");
  const marker = disagreementMarker.trim()
    ? `\n\n${disagreementMarker.trim()}`
    : "";
  return `\n\n${directive.trim()}${marker}\n\n## Expert Drafts to Synthesize\n\n${draftBlock}`;
}
