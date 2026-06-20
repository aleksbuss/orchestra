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
 *
 * Sprint A1 (context-management track): `content` on a `ModelMessage` is NOT
 * always a string. Tool-call / tool-result / multimodal turns carry an ARRAY of
 * parts (see `convertChatMessagesToModelMessages` in agent-messages.ts). The old
 * `(m.content as string)?.length` returned the ARRAY LENGTH (e.g. `1` for a
 * single 50 KB tool-result), so a tool-loop that read large files was estimated
 * at near-zero tokens and never triggered compaction — the root cause of the
 * mid-loop context-overflow crashes. We now sum the character length of every
 * part. The /3.5 divisor stays a rough English/code heuristic; swapping in a real
 * BPE tokenizer (and per-language calibration) is a deliberate follow-up.
 */
export function estimateTokenCount(messages: ModelMessage[]): number {
  let count = 0;
  for (const m of messages) {
    count += contentCharLength(m.content);
  }
  return Math.ceil(count / 3.5);
}

/**
 * Character count of a `ModelMessage["content"]`, robust to both the string form
 * and the array-of-parts form (text / tool-call / tool-result / file / image).
 */
function contentCharLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    if (part == null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") {
      // { type: "text", text }
      total += p.text.length;
    } else if (p.type === "tool-call") {
      // { type: "tool-call", toolName, input }
      total += stringLen(p.toolName) + serializedLen(p.input);
    } else if (p.type === "tool-result") {
      // { type: "tool-result", toolName, output: { type, value } }
      total += stringLen(p.toolName) + serializedLen(p.output);
    } else {
      // Unknown/multimodal part (image/file/etc.) — fall back to its serialized
      // size so large inline payloads still register as context pressure.
      total += serializedLen(part);
    }
  }
  return total;
}

function stringLen(v: unknown): number {
  return typeof v === "string" ? v.length : 0;
}

function serializedLen(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}
