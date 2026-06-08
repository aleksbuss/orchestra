import { generateText } from "ai";
import { resolveMaxOutputTokens } from "@/lib/providers/model-output-limits";
import { createModel } from "@/lib/providers/llm-provider";
import type { AppSettings, ModelConfig } from "@/lib/types";
import type { RawUsage } from "@/lib/cost/accumulator";

const REFLECTION_SYSTEM_PROMPT = `You are a QA Auditor reviewing an AI agent's response. Analyze the response for:

1. **Factual errors** — claims that contradict common knowledge or the user's stated context.
2. **Incomplete answers** — user's question not fully addressed; missing key parts.
3. **Code bugs** — missing imports, syntax errors, type mismatches, undefined variables.
4. **Security issues** — exposed secrets, SQL injection, XSS vectors in generated code.
5. **Logical inconsistencies** — contradictions within the response itself.

Output a JSON object and nothing else:

If the response is acceptable:
{"shouldRevise": false, "critique": "", "suggestion": ""}

If there are issues:
{"shouldRevise": true, "critique": "<concise description of what is wrong>", "suggestion": "<specific fix instructions>"}

Rules:
- Only flag genuine issues. Do not flag stylistic preferences.
- Never flag the response for being brief if it answers the question.
- Be concise in critique and suggestion — max 2 sentences each.`;

const REVISOR_SYSTEM_PROMPT = `You are a careful editor. Given an original AI response AND a specific critique with suggested fixes, produce a revised version that fixes the issues identified.

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
  /** The revised text — replaces the original aggregator output. */
  text: string;
  usage?: RawUsage;
  modelConfig?: Pick<ModelConfig, "provider" | "model">;
}

/**
 * Reflect on an agent's response using a lightweight utility model.
 * Returns whether the response should be revised and what to fix.
 */
export async function reflectOnResponse(params: {
  userMessage: string;
  agentResponse: string;
  settings: AppSettings;
  projectId?: string;
  abortSignal?: AbortSignal;
}): Promise<ReflectionResult> {
  const { userMessage, agentResponse, settings, projectId, abortSignal } = params;

  // Skip reflection for very short or trivial responses
  if (agentResponse.length < 30) {
    return { shouldRevise: false, critique: "", suggestion: "" };
  }

  try {
    const modelConfig = { ...(settings.utilityModel ?? settings.chatModel) };
    if (!modelConfig.apiKey && settings.providerApiKeys?.[modelConfig.provider]) {
      modelConfig.apiKey = settings.providerApiKeys[modelConfig.provider];
    }
    const model = createModel(modelConfig, { projectId });

    const result = await generateText({
      model,
      system: REFLECTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `## User's original message:\n${userMessage}\n\n` +
            `## Agent's response to review:\n${agentResponse}`,
        },
      ],
      temperature: 0.1, // Low temperature for consistent QA judgements
      maxOutputTokens: 256, // Keep it cheap and fast
      abortSignal,
    });

    const text = result.text.trim();
    const modelAttribution = {
      provider: modelConfig.provider,
      model: modelConfig.model,
    };

    // Try to parse JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        return {
          shouldRevise: Boolean(parsed.shouldRevise),
          critique: typeof parsed.critique === "string" ? parsed.critique : "",
          suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : "",
          usage: result.usage as RawUsage | undefined,
          modelConfig: modelAttribution,
        };
      } catch {
        // JSON parse failed — treat as no issues (still record usage so the
        // banner reflects what the failed reflection attempt cost).
      }
    }

    return {
      shouldRevise: false,
      critique: "",
      suggestion: "",
      usage: result.usage as RawUsage | undefined,
      modelConfig: modelAttribution,
    };
  } catch (err) {
    // Reflection failure should never block the main response
    console.warn("[Reflection] Self-critique failed, skipping:", err);
    return { shouldRevise: false, critique: "", suggestion: "" };
  }
}

/**
 * Apply a reflection critique to revise the original response (PM #38).
 *
 * Generator-Critic-Revisor loop pattern (Reflexion / LangChain Reflection
 * Agents). Runs on the BRAIN model — the revisor needs the same horsepower
 * as the original aggregator since it must preserve correct content while
 * fixing the flagged issues. Failure modes:
 *
 *   - Revisor throws → return original text unchanged (never block on a
 *     revision step; the user gets the original aggregator output).
 *   - Revisor empties response → keep original (defensive).
 *
 * Usage capture is mandatory (PM #36 cost-banner contract).
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
    abortSignal,
  } = params;

  try {
    const modelConfig = { ...(modelOverride ?? settings.chatModel) };
    if (!modelConfig.apiKey && settings.providerApiKeys?.[modelConfig.provider]) {
      modelConfig.apiKey = settings.providerApiKeys[modelConfig.provider];
    }
    const model = createModel(modelConfig, { projectId });

    const result = await generateText({
      model,
      system: REVISOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `## User's original message:\n${userMessage}\n\n` +
            `## Original response:\n${originalResponse}\n\n` +
            `## Critique:\n${critique}\n\n` +
            `## Suggested fix:\n${suggestion}`,
        },
      ],
      temperature: 0.3,
      maxOutputTokens: resolveMaxOutputTokens(modelConfig),
      abortSignal,
    });

    const revisedText = result.text?.trim() ?? "";
    if (!revisedText) {
      console.warn("[Reflection] Revisor produced empty output — keeping original.");
      return { text: originalResponse };
    }

    return {
      text: revisedText,
      usage: result.usage as RawUsage | undefined,
      modelConfig: {
        provider: modelConfig.provider,
        model: modelConfig.model,
      },
    };
  } catch (err) {
    console.warn("[Reflection] Revision step failed, keeping original:", err);
    return { text: originalResponse };
  }
}
