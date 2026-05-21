import { generateText, type ModelMessage } from "ai";
import { createModel } from "@/lib/providers/llm-provider";
import type { AppSettings, ChatMessage } from "@/lib/types";

const COMPRESSOR_SYSTEM_PROMPT = `You are a Context Archivist Agent.
Your task is to analyze the following sequence of old chat messages and create a single, highly dense "Working Memory" summary.
You MUST preserve:
1. Any factual information provided by the user (API keys, constraints, URLs).
2. All technical decisions made during the conversation.
3. File paths and the state of the codebase discussed.
4. Any unresolved bugs or pending tasks.

Remove all conversational filler (e.g., "hello", "let me do that", "here is the result").
Format your output as a concise markdown list of facts and states.`;

export async function compressChatHistory(
  messages: ChatMessage[],
  settings: AppSettings,
  projectId?: string,
  abortSignal?: AbortSignal
): Promise<string> {
  if (messages.length === 0) return "";

  // Convert ChatMessage to a readable string format
  const formattedLogs = messages
    .filter((msg) => msg.role !== "system" || msg.content.includes("Working Memory")) // Skip internal system prompts except old memory
    .map((msg) => `[${msg.role.toUpperCase()}]: ${msg.content}`)
    .join("\n\n");

  const promptText = `Please compress this chat history into a dense summary:\n\n${formattedLogs}`;

  try {
    const modelConfig = { ...(settings.utilityModel ?? settings.chatModel) };
    if (!modelConfig.apiKey && settings.providerApiKeys?.[modelConfig.provider]) {
      modelConfig.apiKey = settings.providerApiKeys[modelConfig.provider];
    }
    const model = createModel(modelConfig, {
      projectId,
    });

    const result = await generateText({
      model,
      system: COMPRESSOR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: promptText }],
      abortSignal,
    });
    return result.text.trim();
  } catch (err) {
    console.error("Compression failed:", err);
    return `[Context Compression Failed: ${err}]`;
  }
}

/**
 * Heuristic to estimate token count since we lack tiktoken in browser/edge easily.
 * Roughly 3.5 to 4 characters per token for English/Code.
 */
export function estimateTokenCount(messages: ModelMessage[]): number {
  let count = 0;
  for (const m of messages) {
    count += (m.content as string)?.length || 0;
  }
  return Math.ceil(count / 3.5);
}
