import { generateText, generateObject } from "ai";
import { z } from "zod";
import { createModel } from "@/lib/providers/llm-provider";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import type { AppSettings, ModelConfig } from "@/lib/types";
import type { RawUsage } from "@/lib/cost/accumulator";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import type { SwarmNodeStatus } from "@/lib/realtime/types";
import {
  collectCompilerEvidence,
  formatCompilerEvidenceSection,
} from "./reflection-evidence";

const REFLECTION_SYSTEM_PROMPT = `You are an Adversarial Critic and QA Auditor reviewing an AI agent's response. Analyze the response using the Doubt-Driven Development methodology.

CRITICAL RULE 1: Mitigate Sycophancy. Do NOT agree with the agent simply because they provided a detailed, confident-sounding answer. Assume there are hidden flaws.
CRITICAL RULE 2: Reason first (apply the CLAIM -> EXTRACT -> DOUBT framework), THEN emit the verdict. The verdict MUST be the LAST thing you output: a single JSON object on its own, with no text, prose, or fences after it.
CRITICAL RULE 3: Analyze scaling, race conditions, memory leaks, security vulnerabilities, and factual contradictions.

Analyze the response for:
1. **Factual errors** — claims that contradict common knowledge or the user's stated context.
2. **Incomplete answers** — user's question not fully addressed; missing key parts.
3. **Code bugs** — missing imports, syntax errors, type mismatches, undefined variables.
4. **Security issues** — exposed secrets, SQL injection, XSS vectors in generated code.

The FINAL line of your output must be one of these JSON objects.

If the response is fully robust and production-ready:
{"shouldRevise": false, "critique": "", "suggestion": ""}

If there are issues:
{"shouldRevise": true, "critique": "<concise description of what is wrong>", "suggestion": "<specific fix instructions>"}

Rules for the JSON verdict:
- Only flag genuine issues. Do not hallucinate edge cases just to be contrarian.
- Never flag the response for being brief if it answers the question.
- Be concise in critique and suggestion — max 2 sentences each.`;

const REVISOR_SYSTEM_PROMPT = `You are a careful editor. Given an original AI response AND a specific critique with suggested fixes, produce a revised version that fixes the issues identified.

Rules:
- Keep the parts of the original that were not flagged as problematic.
- Apply the suggested fixes precisely.
- Do NOT introduce new claims or sections that weren't in the original or the critique.
- Preserve code blocks verbatim except where the critique specifically targets them.
- If the critique is fundamentally wrong, hallucinates an issue, or asks for an impossible fix, set status to "cannot_fix".`;

// Text-mode revisor for models that cannot reliably produce structured output
// (many free / small models). Same editing rules, but the whole reply IS the
// revised response — no schema, no preamble.
const REVISOR_TEXT_SYSTEM_PROMPT = `You are a careful editor. Given an original AI response AND a specific critique with suggested fixes, produce a revised version that fixes the issues identified.

Rules:
- Keep the parts of the original that were not flagged as problematic.
- Apply the suggested fixes precisely.
- Do NOT introduce new claims or sections that weren't in the original or the critique.
- Preserve code blocks verbatim except where the critique specifically targets them.
- Output ONLY the revised response — no preamble like "Here is the revised version" and no explanation of what you changed.`;

export interface ReflectionResult {
  shouldRevise: boolean;
  critique: string;
  suggestion: string;
  /** PM #36 — token usage so the caller can fold this into the chat banner. */
  usage?: RawUsage;
  /** Which model produced the reflection (provider, model) — for cost attribution. */
  modelConfig?: Pick<ModelConfig, "provider" | "model">;
}

export interface RevisionResult {
  /** The revised text, or the original text if the critique cannot be applied. */
  text: string;
  status: "fixed" | "cannot_fix";
  explanation?: string;
  usage?: RawUsage;
  modelConfig?: Pick<ModelConfig, "provider" | "model">;
}

/**
 * Skip reflection for very short / trivial responses ("ok", "thanks", a
 * one-line answer). Paying a full critic (plus retries) on these is pure waste.
 */
const MIN_RESPONSE_LEN_FOR_REFLECTION = 30;

/**
 * Extract the critic's JSON verdict from free-form text.
 *
 * PM audit C1: the critic is instructed to reason before emitting the verdict,
 * and that reasoning routinely contains braces (code snippets, `{a:1}`), so a
 * greedy `/\{[\s\S]*\}/` (first `{` → last `}`) captures the reasoning too and
 * fails to parse. Instead we scan for the LAST balanced `{...}` that contains
 * the `shouldRevise` key — the verdict is always last. Reasoning braces before
 * it are ignored.
 */
export function extractCriticVerdict(
  raw: string
): { shouldRevise: boolean; critique: string; suggestion: string } | null {
  const candidate = findLastBalancedObject(raw);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (!("shouldRevise" in parsed)) return null;
    return {
      shouldRevise: Boolean(parsed.shouldRevise),
      critique: typeof parsed.critique === "string" ? parsed.critique : "",
      suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : "",
    };
  } catch {
    return null;
  }
}

/** Walk back from each `}` to its matching `{`; return the last balanced
 * object that mentions `shouldRevise`. Ignores braces in prior reasoning. */
function findLastBalancedObject(text: string): string | null {
  for (let end = text.lastIndexOf("}"); end !== -1; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i -= 1) {
      const c = text[i];
      if (c === "}") depth += 1;
      else if (c === "{") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(i, end + 1);
          if (candidate.includes("shouldRevise")) return candidate;
          break; // this object has no verdict — try an earlier `}`
        }
      }
    }
  }
  return null;
}

/**
 * Reflect on an agent's response with a critic model.
 *
 * Resilience: an API failure (network / rate-limit) is retried once on the
 * utility model. A PARSE failure is NOT retried — a critic that cannot emit a
 * parseable verdict has no actionable critique, so we skip gracefully rather
 * than burn a second call to produce the same unparseable output (audit C1).
 */
export async function reflectOnResponse(params: {
  userMessage: string;
  agentResponse: string;
  settings: AppSettings;
  /** Allow the caller to override the critic model (e.g. MoA passes the brain
   * model for Deep Audit Mode). */
  modelOverride?: ModelConfig;
  projectId?: string;
  chatId?: string;
  abortSignal?: AbortSignal;
}): Promise<ReflectionResult> {
  const { userMessage, agentResponse, settings, modelOverride, projectId, chatId, abortSignal } = params;

  // Q2 — skip trivial responses.
  if (agentResponse.trim().length < MIN_RESPONSE_LEN_FOR_REFLECTION) {
    return { shouldRevise: false, critique: "", suggestion: "" };
  }

  // R3 — one stable DAG node for the whole audit, so start → terminal is a
  // single node that transitions (not two orphaned nodes).
  const nodeId = crypto.randomUUID();
  const publishNode = (status: SwarmNodeStatus, taskSummary: string, reason: string) => {
    if (!chatId) return;
    publishUiSyncEvent({
      topic: "chat",
      chatId,
      projectId: projectId ?? null,
      reason,
      nodeType: "system_node",
      swarmNode: {
        nodeId,
        // Parent under the orchestrator (its DAG nodeId is the chatId) so the
        // audit node nests in the tree instead of rendering as a stray root.
        parentNodeId: chatId,
        role: "reviewer",
        taskSummary,
        status,
        ...(status === "running"
          ? { startedAt: new Date().toISOString() }
          : { completedAt: new Date().toISOString() }),
      },
    });
  };

  // DDD Phase 4 (corrected) — deterministic syntax evidence for any fenced
  // TS/JS/JSON blocks in the draft. ADVISORY input to the critic (grounds the
  // syntax half of its audit; prevents hallucinated syntax errors), never a
  // verdict over it. `collectCompilerEvidence` is fail-safe: null on anything
  // unexpected, so reflection can never be blocked by the checker.
  const compilerEvidence = await collectCompilerEvidence(agentResponse);
  const evidenceSection = compilerEvidence
    ? formatCompilerEvidenceSection(compilerEvidence)
    : "";

  const maxAttempts = 2; // Primary + one API-failure fallback.
  let lastError: unknown = null;

  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const isFallback = attempts > 1;
    const baseModel = !isFallback && modelOverride ? modelOverride : settings.utilityModel ?? settings.chatModel;
    const modelConfig = { ...baseModel };
    if (!modelConfig.apiKey && settings.providerApiKeys?.[modelConfig.provider]) {
      modelConfig.apiKey = settings.providerApiKeys[modelConfig.provider];
    }
    const modelAttribution = { provider: modelConfig.provider, model: modelConfig.model };

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      const model = createModel(modelConfig, { projectId });
      publishNode(
        "running",
        "Skeptic Audit",
        isFallback
          ? `[Skeptic] Retrying audit on ${modelConfig.provider}/${modelConfig.model}...`
          : `[Skeptic] Auditing draft using ${modelConfig.provider}/${modelConfig.model}...`
      );
      result = await generateText({
        model,
        system: REFLECTION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content:
              `## User's original message:\n${userMessage}\n\n` +
              `## Agent's response to review:\n${agentResponse}` +
              evidenceSection,
          },
        ],
        temperature: 0.1,
        maxOutputTokens: 1024,
        abortSignal,
      });
    } catch (err) {
      // API-level failure — retry once on the fallback model.
      lastError = err;
      console.warn(
        `[Reflection] Self-critique attempt ${attempts} API error:`,
        err instanceof Error ? err.message : err
      );
      if (abortSignal?.aborted) break;
      continue;
    }

    // Defensive: a provider that returns a malformed/empty envelope is treated
    // as an API anomaly (retry-able), not a parse miss.
    if (!result || typeof result.text !== "string") {
      lastError = new Error("Critic returned an empty result envelope.");
      if (abortSignal?.aborted) break;
      continue;
    }

    // The call succeeded — parse the verdict. A parse miss is terminal (no
    // retry): treat it as "no actionable critique" and skip gracefully.
    const verdict = extractCriticVerdict(result.text.trim());
    if (!verdict) {
      console.warn("[Reflection] No parseable verdict in critic output — skipping revision.");
      publishNode("completed", "Draft Approved", "[Skeptic] No actionable critique parsed.");
      return {
        shouldRevise: false,
        critique: "",
        suggestion: "",
        usage: result.usage as RawUsage | undefined,
        modelConfig: modelAttribution,
      };
    }

    publishNode(
      "completed",
      verdict.shouldRevise ? "Draft Rejected" : "Draft Approved",
      verdict.shouldRevise
        ? `[Skeptic] Rejected draft! Issue: ${verdict.critique} | Suggestion: ${verdict.suggestion}`
        : `[Skeptic] Draft passed audit. No critical flaws found.`
    );
    return {
      ...verdict,
      usage: result.usage as RawUsage | undefined,
      modelConfig: modelAttribution,
    };
  }

  // Both API attempts failed — never block the main response.
  console.error("[Reflection] All critic attempts failed. Bypassing critic.", lastError);
  publishNode("error", "Audit Unavailable", "[Skeptic] Audit unavailable — proceeding with the draft.");
  return { shouldRevise: false, critique: "", suggestion: "" };
}

/**
 * Apply a reflection critique to revise the original response (PM #38).
 *
 * Runs on the BRAIN model. Two paths (audit R2):
 *   1. Structured output (`generateObject`) — reliable status/diff on strong
 *      models.
 *   2. On structured-output failure, a tolerant TEXT revision (`generateText`)
 *      whose whole reply is the revised response — so weak/free models (which
 *      often can't satisfy a JSON schema) still get a working revision instead
 *      of a silent no-op that returns the un-revised original.
 *
 * Any total failure returns the original text unchanged (never blocks).
 */
export async function reviseWithCritique(params: {
  userMessage: string;
  originalResponse: string;
  critique: string;
  suggestion: string;
  settings: AppSettings;
  /** Optional override — defaults to settings.chatModel (the brain). */
  modelOverride?: ModelConfig;
  projectId?: string;
  chatId?: string;
  abortSignal?: AbortSignal;
}): Promise<RevisionResult> {
  const {
    userMessage,
    originalResponse,
    critique,
    suggestion,
    settings,
    modelOverride,
    projectId,
    chatId,
    abortSignal,
  } = params;

  const modelConfig = { ...(modelOverride ?? settings.chatModel) };
  if (!modelConfig.apiKey && settings.providerApiKeys?.[modelConfig.provider]) {
    modelConfig.apiKey = settings.providerApiKeys[modelConfig.provider];
  }
  const attribution = { provider: modelConfig.provider, model: modelConfig.model };
  const maxOutputTokens = resolveMaxOutputTokens(modelConfig);
  const userContent =
    `## User's original message:\n${userMessage}\n\n` +
    `## Original response:\n${originalResponse}\n\n` +
    `## Critique:\n${critique}\n\n` +
    `## Suggested fix:\n${suggestion}`;

  // R3 — one stable DAG node for the whole revision.
  const nodeId = crypto.randomUUID();
  const publishNode = (status: SwarmNodeStatus, taskSummary: string, reason: string) => {
    if (!chatId) return;
    publishUiSyncEvent({
      topic: "chat",
      chatId,
      projectId: projectId ?? null,
      reason,
      nodeType: "system_node",
      swarmNode: {
        nodeId,
        // Parent under the orchestrator (its DAG nodeId is the chatId).
        parentNodeId: chatId,
        role: "coder",
        taskSummary,
        status,
        ...(status === "running"
          ? { startedAt: new Date().toISOString() }
          : { completedAt: new Date().toISOString() }),
      },
    });
  };

  publishNode("running", "Code Revision", "[Revisor] Fixing draft based on the Skeptic's critique...");

  // Attempt 1 — structured output.
  try {
    const model = createModel(modelConfig, { projectId });
    const result = await generateObject({
      model,
      schema: z.object({
        status: z
          .enum(["fixed", "cannot_fix"])
          .describe("Whether the critique was successfully applied or if it cannot be fixed."),
        explanation: z.string().describe("Explanation of what was changed, or why it cannot be fixed."),
        diff: z
          .string()
          .describe("The fully revised response. If status is cannot_fix, this can be empty or the original text."),
      }),
      system: REVISOR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.3,
      maxOutputTokens,
      abortSignal,
    });

    const revisedText = result.object.diff?.trim() ?? "";
    const isCannotFix = result.object.status === "cannot_fix";
    if (!revisedText && !isCannotFix) {
      publishNode("completed", "Revision Failed", "[Revisor] Empty output — keeping original.");
      return {
        text: originalResponse,
        status: "cannot_fix",
        explanation: "Empty output",
        usage: result.usage as RawUsage | undefined,
        modelConfig: attribution,
      };
    }
    publishNode(
      "completed",
      isCannotFix ? "Revision Failed" : "Revision Complete",
      isCannotFix
        ? `[Revisor] Unable to fix: the critique asks for an impossible or hallucinatory fix.`
        : `[Revisor] Draft successfully revised.`
    );
    return {
      text: isCannotFix && !revisedText ? originalResponse : revisedText,
      status: result.object.status,
      explanation: result.object.explanation,
      usage: result.usage as RawUsage | undefined,
      modelConfig: attribution,
    };
  } catch (structuredErr) {
    if (abortSignal?.aborted) {
      publishNode("error", "Revision Failed", "[Revisor] Aborted — keeping original.");
      return { text: originalResponse, status: "cannot_fix", explanation: "aborted" };
    }
    console.warn(
      "[Reflection] Structured revision failed, falling back to text revision:",
      structuredErr instanceof Error ? structuredErr.message : structuredErr
    );
  }

  // Attempt 2 — tolerant text revision (weak models without reliable structured output).
  try {
    const model = createModel(modelConfig, { projectId });
    const result = await generateText({
      model,
      system: REVISOR_TEXT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.3,
      maxOutputTokens,
      abortSignal,
    });
    const revisedText = result.text.trim();
    if (!revisedText) {
      publishNode("completed", "Revision Failed", "[Revisor] Empty output — keeping original.");
      return {
        text: originalResponse,
        status: "cannot_fix",
        explanation: "Empty output",
        usage: result.usage as RawUsage | undefined,
        modelConfig: attribution,
      };
    }
    publishNode("completed", "Revision Complete", "[Revisor] Draft revised (text mode).");
    return {
      text: revisedText,
      status: "fixed",
      explanation: "Revised via text fallback.",
      usage: result.usage as RawUsage | undefined,
      modelConfig: attribution,
    };
  } catch (textErr) {
    console.error("[Reflection] Both structured and text revision failed, keeping original:", textErr);
    publishNode("error", "Revision Failed", "[Revisor] Failed — keeping original.");
    return { text: originalResponse, status: "cannot_fix", explanation: String(textErr) };
  }
}

/**
 * DDD Phase 1 (corrected) — reflection-loop outcome classification.
 *
 * The original plan wanted a whole OpenTelemetry-style tracer module
 * (`observability/tracer.ts`, `MoaTelemetrySpan`, a new `.jsonl` sink). That
 * duplicates what Orchestra already ships — the structured logger
 * (`data/logs/*.jsonl`), trace-memory, the cost accumulator, and SSE swarm
 * nodes — and violates the no-APM local-first posture. The corrected design is
 * ONE structured log event per reflection run (`ddd_reflection_outcome`,
 * emitted by `moa.ts` through the EXISTING logger) whose payload carries this
 * outcome. The roadmap's aggregate metrics are then offline queries over the
 * daily JSONL, not new session-state fields:
 *   - critic_rejection_rate  = share of events with `revisionsExecuted > 0`
 *   - average_reflection_rounds = mean of `rounds`
 *
 * Pure precedence over the loop's exit flags; the flag semantics come from the
 * PM #51 locals in `moa.ts`. `cannot_fix` wins over `critic_clean` (a run that
 * ended on an unresolvable critique is NOT clean even if an earlier round was),
 * and `revised` is the fallthrough: revision applied, loop ended by
 * maxRounds === 1 without the cap flag (which requires maxRounds > 1).
 */
export type ReflectionOutcome =
  | "critic_clean"
  | "cannot_fix"
  | "converged"
  | "max_rounds"
  | "revised";

export function deriveReflectionOutcome(flags: {
  criticCleanedUp: boolean;
  cannotFix: boolean;
  converged: boolean;
  hitCap: boolean;
}): ReflectionOutcome {
  if (flags.cannotFix) return "cannot_fix";
  if (flags.criticCleanedUp) return "critic_clean";
  if (flags.converged) return "converged";
  if (flags.hitCap) return "max_rounds";
  return "revised";
}
