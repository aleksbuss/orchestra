/**
 * PM #57 — extracted from `moa.ts`. Dynamic Persona Generation (DPG)
 * for the MoA Router. Calls `generateObject` against the utility model
 * to produce 3–5 hyper-specialized expert personas tailored to the
 * user's prompt; falls back to `MOA_PROPOSERS` (the static set in
 * `moa-personas.ts`) on any failure.
 *
 * Honors:
 *   - PM #37 — force-injects the canonical Adversarial Critic when the
 *     LLM omits a skeptic persona, capped at 5 personas total.
 *   - PM #42/#45 — skeptic detection goes through `detectProposerRole`
 *     so PM #42 tool-routing and PM #37 force-injection see the same
 *     "is this a reviewer?" answer.
 *   - PM #48 — passes the `modelTier` hint into the Zod schema so the
 *     LLM can suggest cheap-Haiku-for-Skeptic / Opus-for-Coder routing.
 *   - PM #51 — accepts an optional `fewShotsBlock` rendered from past
 *     successful traces, appended to the Router prompt to bias persona
 *     generation toward proven patterns.
 *
 * Re-exported from `./moa` for backward compat.
 */

import { generateObject, type ModelMessage } from "ai";
import { z } from "zod";
import type { ModelConfig } from "@/lib/types";
import { createModel } from "@/lib/providers/llm-provider";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import {
  detectProposerRole,
  MOA_PROPOSERS,
  type MoAProposer,
} from "@/lib/agent/moa-personas";

export interface DPGResult {
  requiresSwarm: boolean;
  personas: MoAProposer[];
  /** Router LLM usage so the caller can fold it into the chat cumulative (PM #36). */
  usage?: import("@/lib/cost/accumulator").RawUsage;
}

/**
 * Dynamically generates 3-5 hyper-specialized expert personas tailored to the user's prompt.
 * Includes Intelligent Bypass: evaluates if the task actually needs a swarm.
 */
export async function generateDynamicSwarm(
  userMessage: string,
  history: ModelMessage[],
  modelConfig: ModelConfig,
  searchEnabled: boolean,
  abortSignal?: AbortSignal,
  // PM #51 — rendered past-trace fewshots block. Empty string when
  // trace memory is disabled or no relevant traces found. Appended
  // after the INSTRUCTIONS list so it biases persona generation
  // without interfering with the structured-output schema.
  fewShotsBlock: string = ""
): Promise<DPGResult> {
  try {
    // Format the last 5 messages for context — content can be string or array (tool-calls)
    const recentContext = history.slice(-5).map(m => {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(p => (typeof p === "object" && p !== null && "text" in p ? (p as {text: string}).text : "")).join(" ")
          : String(m.content);
      return `[${m.role.toUpperCase()}]: ${text.slice(0, 500)}`;
    }).join("\n");

    const routerModel = createModel(modelConfig, {});
    const { object, usage } = await generateObject({
      model: routerModel,
      // Every other LLM call in the agent/MoA path caps output via
      // resolveMaxOutputTokens(settings.<role>Model) (agent.ts, moa.ts). This
      // call was the one exception, so `generateObject` requested the
      // model's own default ceiling (e.g. 65535) — on an account near its
      // OpenRouter credit limit that 402s outright, and the catch below
      // unconditionally falls back to `requiresSwarm: true`. The Router then
      // ALWAYS fans out the full proposer ensemble (more expensive than the
      // failed Router call), silently defeating the "skip trivial prompts"
      // bypass it exists to provide. Confirmed live during forceSwarm
      // verification (2026-06).
      maxOutputTokens: resolveMaxOutputTokens(modelConfig),
      schema: z.object({
        requiresSwarm: z.boolean().describe("Set to false ONLY IF the user's message is a simple conversational reply (e.g. 'thanks', 'hello') or a trivial task that a single AI agent can handle easily without needing a committee of diverse experts."),
        personas: z.array(z.object({
          id: z.string().describe("A short snake_case id (e.g. 'tax_lawyer')"),
          role: z.string().describe("The human-readable Title/Role of the expert (e.g. 'Senior Tax Attorney')"),
          systemPrompt: z.string().describe("The specific system prompt Rules and Guidelines for this expert. MUST follow structure: [GOAL] ... [RULES] ... [FORMAT]"),
          color: z.enum(["slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"]).describe("A distinct tailwind color for UI representation"),
          modelTier: z.enum(["fast", "balanced", "frontier"]).optional().describe("PM #48 — suggested model tier. 'fast' for skeptic/critic/QA personas (cheap, just evaluates). 'balanced' for analyst/researcher (mid quality). 'frontier' for coder/architect/synthesis-heavy personas (best quality). Omit to let Orchestra derive from the role automatically.")
        })).min(3).max(5).describe("List of exactly 3 to 5 highly specialized experts required to answer the user request. Only used if requiresSwarm is true.")
      }),
      prompt: `You are the Orchestra Auto-Swarm Router.
The user has submitted a request. Your job is to determine if a "Dream Team" of experts is needed.

RECENT CONTEXT:
${recentContext}

CURRENT USER REQUEST (truncated if too long):
${userMessage.slice(0, 2000)}

INSTRUCTIONS:
1. If the request is trivial, conversational, or a simple code edit, set requiresSwarm to false.
2. If the request requires multi-faceted analysis, deep architecture, creative brainstorming, or complex problem solving, set requiresSwarm to true.
3. If true, assemble 3 to 5 hyper-specialized domain experts. Do NOT use generic roles.
4. For each expert, provide a highly specific systemPrompt using this exact structure:
   [GOAL] What they are trying to achieve from their narrow perspective.
   [RULES] 2-3 strict guidelines they must follow (e.g., "Always hunt for edge cases", "Never propose complex solutions").
   [FORMAT] How they should format their answer.
5. VERY IMPORTANT: One of your 3-5 experts MUST ALWAYS be a "QA Auditor / Fact-Checker" (e.g., \`skeptic_auditor\`). Their [GOAL] is to doubt the user's premise, search for potential pitfalls, verify library compatibilities via \`search_web\` (if available), and actively try to find edge cases where the proposed solution would fail. When a factual claim looks doubtful — or comes only from a search summary — their [RULES] MUST instruct them to call the \`fetch_webpage\` tool to read the RAW source page and verify it directly. A \`search_web\` snippet is a lead, NOT proof.
6. (PM #48 — model tier hint): for each expert, set \`modelTier\` to "fast" / "balanced" / "frontier":
   - "fast" for QA / Skeptic / Critic / Reviewer personas — they evaluate, not synthesize. Cheap reliable models are enough.
   - "balanced" for Analyst / Researcher / Domain-Expert / Tool-Operator personas — they need clarity, not maximum reasoning depth.
   - "frontier" for Coder / Architect / Implementation / Deep-Synthesis personas — output quality scales meaningfully with model size.
   This lets the operator route different personas to different models (e.g., Skeptic on cheap Haiku, Coder on premium Opus, with the Aggregator unchanged). If you can't decide, omit the field and Orchestra will pick from the role.${searchEnabled ? `
7. VERY IMPORTANT: You have access to the 'search_web' tool. If an expert requires real-time facts, news, documentation, or live data to solve the request, you MUST explicitly instruct them in their [RULES] to call the 'search_web' tool first before answering.` : ""}${fewShotsBlock}`,
      abortSignal,
    });

    // PM #37 — guarantee the QA Auditor / Skeptic. CLAUDE.md §1 promises
    // "one DPG role is ALWAYS forced to be a QA Auditor / Skeptic", but
    // the previous implementation relied entirely on a prompt instruction.
    // A weak utility-model can ignore the instruction and produce 3-5
    // personas without a critic, leaving the swarm without the
    // zero-latency fact-checking mandate. We post-validate the LLM's
    // output and inject the canonical Adversarial Critic if missing.
    //
    // PM #45 — skeptic detection now goes through `detectProposerRole`
    // (the same helper PM #42's tool routing uses). Previously this site
    // had its own narrower SKEPTIC_PATTERN that missed "qa", "quality",
    // "review" — so a DPG-returned persona like "qa_engineer" would be
    // classified as a reviewer by PM #42 (gets search_web) but NOT seen
    // as a skeptic by PM #37 → critic was force-injected anyway, leaving
    // the swarm with two reviewer-shape personas competing for the same
    // role. Single source of truth fixes the inconsistency.
    const hasSkeptic = (object.personas as MoAProposer[]).some(
      (p) => detectProposerRole(p) === "reviewer"
    );
    let personas = object.personas as MoAProposer[];
    if (object.requiresSwarm && !hasSkeptic) {
      console.warn(
        `[MoA] DPG output missing a Skeptic persona — force-injecting canonical 'critic' (PM #37). Roles received: ${object.personas.map((p) => p.id).join(", ")}`
      );
      const canonicalCritic = MOA_PROPOSERS.find((p) => p.id === "critic")!;
      // Cap at 5 personas total to keep the cost envelope predictable.
      // If the LLM already returned 5, evict the LAST one (heuristic:
      // the LLM's tail picks are usually the weakest).
      personas = [...object.personas];
      if (personas.length >= 5) personas.pop();
      personas.push({
        id: canonicalCritic.id,
        role: canonicalCritic.role,
        systemPrompt: canonicalCritic.systemPrompt,
        color: canonicalCritic.color,
      });
    }
    return {
      requiresSwarm: object.requiresSwarm,
      personas,
      usage,
    };
  } catch (err) {
    console.error("[MoA] Dynamic Persona Generation failed. Falling back to universal presets.", err);
    return {
      requiresSwarm: true,
      personas: MOA_PROPOSERS,
      // Usage is unknown when the Router crashes; the chat banner just
      // misses the Router's tokens for this turn (a small undercount).
    };
  }
}
