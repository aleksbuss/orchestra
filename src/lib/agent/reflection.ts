import { generateText } from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import type { AppSettings } from "@/lib/types";

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

export interface ReflectionResult {
  shouldRevise: boolean;
  critique: string;
  suggestion: string;
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
}): Promise<ReflectionResult> {
  const { userMessage, agentResponse, settings, projectId } = params;

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
    });

    const text = result.text.trim();

    // Try to parse JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        return {
          shouldRevise: Boolean(parsed.shouldRevise),
          critique: typeof parsed.critique === "string" ? parsed.critique : "",
          suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : "",
        };
      } catch {
        // JSON parse failed — treat as no issues
      }
    }

    return { shouldRevise: false, critique: "", suggestion: "" };
  } catch (err) {
    // Reflection failure should never block the main response
    console.warn("[Reflection] Self-critique failed, skipping:", err);
    return { shouldRevise: false, critique: "", suggestion: "" };
  }
}
